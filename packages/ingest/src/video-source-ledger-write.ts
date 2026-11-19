// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PresentationCapability, SourceLedgerDeclaration, SourceLedgerMeasurement, SourceLedgerWriteClaim } from '@ingest/video-presentation-store.js';
import { hashStoredObject } from '@ingest/stored-object.js';

/** The production store and real-storage test fixture expose these same ports, per toolInputId instance. */
export interface SourceLedgerOwner {
  claimSourceLedger(identity: PresentationCapability, toolInputId: string, declaration: SourceLedgerDeclaration): Promise<SourceLedgerWriteClaim | null>;
  commitLedger(identity: PresentationCapability, toolInputId: string, owner: string, measured: SourceLedgerMeasurement): Promise<boolean>;
  releaseSourceLedger(identity: PresentationCapability, toolInputId: string, owner: string): Promise<void>;
}

/**
 * Split the producer's one body into its two objects: the compact table bytes first, then the full ledger bytes.
 * @param body - The producer's complete write.
 * @param tableLength - Declared table bytes at the start of the body.
 * @param ledgerLength - Declared ledger bytes after them.
 * @param sinks - The table and ledger object streams.
 * @param sinks.table - Where the table bytes go.
 * @param sinks.ledger - Where the ledger bytes go.
 * @param signal - Aborted when either object write is refused.
 * @returns Nothing once both streams are closed with exactly their declared bytes.
 * @throws {Error} When the body is shorter or longer than both declared lengths, or a write is aborted.
 */
async function split(body: ReadableStream<Uint8Array>, tableLength: number, ledgerLength: number,
  sinks: { table: WritableStream<Uint8Array>; ledger: WritableStream<Uint8Array> }, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const table = sinks.table.getWriter();
  const ledger = sinks.ledger.getWriter();
  const stop = (reason: unknown): Promise<unknown> => Promise.allSettled([reader.cancel(reason), table.abort(reason), ledger.abort(reason)]);
  const onAbort = (): void => { void stop(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    let tableLeft = tableLength;
    let ledgerLeft = ledgerLength;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const head = value.subarray(0, tableLeft);
      const rest = value.subarray(head.length);
      if (head.length > 0) {
        await table.write(head);
        tableLeft -= head.length;
        if (tableLeft === 0) await table.close();
      }
      if (rest.length > ledgerLeft) throw new Error('Source ledger body is longer than its declaration');
      if (rest.length > 0) { await ledger.write(rest); ledgerLeft -= rest.length; }
    }
    if (tableLeft > 0 || ledgerLeft > 0) throw new Error('Source ledger body is shorter than its declaration');
    await ledger.close();
  } catch (error) {
    await stop(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Writes the producer's one body as its two objects through the toolInputId writer's durable claim.
 * @param input - Real R2, original owner and complete trusted producer stream.
 * @returns A physical publication acknowledgement.
 * @throws {Error} When the original stream or physical storage cannot complete.
 */
export async function writeVideoSourceLedger(input: {
  bucket: R2Bucket; owner: SourceLedgerOwner; identity: PresentationCapability; toolInputId: string; declaration: SourceLedgerDeclaration; body: ReadableStream<Uint8Array>;
}): Promise<{ ok: boolean; status: number }> {
  const claim = await input.owner.claimSourceLedger(input.identity, input.toolInputId, input.declaration);
  if (claim === null) { await input.body.cancel(); return { ok: false, status: 409 }; }
  let committed = false;
  const controller = new AbortController();
  try {
    if (input.identity.deadlineAt <= Date.now()) { await input.body.cancel(); return { ok: false, status: 409 }; }
    const tableStream = new FixedLengthStream(claim.table.byteLength);
    const ledgerStream = new FixedLengthStream(claim.byteLength);
    const options = (priorETag: string | null): R2PutOptions => ({
      onlyIf: priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: priorETag },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sourceLedgerJobId: input.identity.jobId, sourceLedgerClaimOwner: claim.owner },
    });
    const fence = (written: R2Object | null): R2Object | null => {
      if (written === null) controller.abort(new Error('Source ledger object version changed'));
      return written;
    };
    const writingTable = input.bucket.put(claim.table.key, tableStream.readable, options(claim.table.priorETag)).then(fence);
    const writingLedger = input.bucket.put(claim.key, ledgerStream.readable, options(claim.priorETag)).then(fence);
    const splitting = split(input.body, claim.table.byteLength, claim.byteLength, { table: tableStream.writable, ledger: ledgerStream.writable }, controller.signal);
    let table: R2Object | null;
    let ledger: R2Object | null;
    try { [table, ledger] = await Promise.all([writingTable, writingLedger, splitting]); }
    catch (error) {
      controller.abort(error);
      await Promise.allSettled([writingTable, writingLedger, splitting]);
      throw error;
    }
    if (table === null || ledger === null) return { ok: false, status: 409 };
    committed = await input.owner.commitLedger(input.identity, input.toolInputId, claim.owner, {
      etag: ledger.etag, size: ledger.size, sha256: await hashStoredObject(input.bucket, claim.key),
      table: { etag: table.etag, size: table.size, sha256: await hashStoredObject(input.bucket, claim.table.key) },
    });
    return { ok: committed, status: committed ? 200 : 409 };
  } finally {
    if (!committed) await input.owner.releaseSourceLedger(input.identity, input.toolInputId, claim.owner);
  }
}
