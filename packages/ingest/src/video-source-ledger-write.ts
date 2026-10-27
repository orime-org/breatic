// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { AlphaPackedIdentity, AlphaPackedReceipt, SourceLedgerDeclaration, SourceLedgerWriteClaim } from '@ingest/video-presentation-store.js';
import { hashStoredObject } from '@ingest/stored-object.js';

/** The production store and real-storage test fixture expose these same ports. */
export interface SourceLedgerOwner {
  claimSourceLedger(identity: AlphaPackedIdentity, declaration: SourceLedgerDeclaration): Promise<SourceLedgerWriteClaim | null>;
  completeSourceLedger(identity: AlphaPackedIdentity, owner: string, measured: AlphaPackedReceipt): Promise<boolean>;
  releaseSourceLedger(identity: AlphaPackedIdentity, owner: string): Promise<void>;
}

/**
 * Writes one original companion stream through its durable claim.
 * @param input - Real R2, original owner and complete trusted producer stream.
 * @returns A physical publication acknowledgement.
 * @throws {Error} When the original stream or physical storage cannot complete.
 */
export async function writeVideoSourceLedger(input: {
  bucket: R2Bucket; owner: SourceLedgerOwner; identity: AlphaPackedIdentity; declaration: SourceLedgerDeclaration; body: ReadableStream<Uint8Array>;
}): Promise<{ ok: boolean; status: number }> {
  const claim = await input.owner.claimSourceLedger(input.identity, input.declaration);
  if (claim === null) { await input.body.cancel(); return { ok: false, status: 409 }; }
  let committed = false;
  const controller = new AbortController();
  try {
    if (input.identity.deadlineAt <= Date.now()) { await input.body.cancel(); return { ok: false, status: 409 }; }
    const fixed = new FixedLengthStream(claim.byteLength);
    const piping = input.body.pipeTo(fixed.writable, { signal: controller.signal });
    const writing = input.bucket.put(claim.key, fixed.readable, {
      onlyIf: claim.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.priorETag },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sourceLedgerJobId: input.identity.jobId, sourceLedgerClaimOwner: claim.owner },
    }).then(written => {
      if (written === null) controller.abort(new Error('Source ledger object version changed'));
      return written;
    });
    let written: R2Object | null;
    try { [written] = await Promise.all([writing, piping]); }
    catch (error) {
      controller.abort(error);
      await Promise.allSettled([writing, piping]);
      throw error;
    }
    if (written === null) return { ok: false, status: 409 };
    committed = await input.owner.completeSourceLedger(input.identity, claim.owner, {
      etag: written.etag, size: written.size, sha256: await hashStoredObject(input.bucket, claim.key),
    });
    return { ok: committed, status: committed ? 200 : 409 };
  } finally {
    if (!committed) await input.owner.releaseSourceLedger(input.identity, claim.owner);
  }
}
