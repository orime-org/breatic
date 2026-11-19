// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real R2 publication of the full ledger and its compact object (inner#1306,
 * test plan §89 rewrite; frames-split design §7.3 Rf/Rc, §7.4).
 *
 * The write mechanics are unchanged by the design: one producer body split into
 * the compact and full objects with fixed MIME and the original owner metadata,
 * short or long streams refused and drained, a completed receipt replayed without
 * a PUT, a lost commit or acknowledgement recovered from the real objects, and the
 * deadline rechecked after a claim. What changes is the identity: the writer is
 * the toolInputId's writer from Tp, and the write points are
 * `claimSourceLedger`, `commitLedger` and `releaseSourceLedger` for that
 * toolInputId.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it, vi, type Mock } from 'vitest';
import * as writeModule from '@ingest/video-source-ledger-write.js';
import { digest, fullKeyFor, stream, tableKeyFor } from './helpers/source-ledger-fixture.js';
import { DECLARATION, expectedReceipt, FULL, H, LEDGER_BODY, ledgerCase, ledgerPort, T, TABLE, withStore, type Identity, type LedgerPort } from './helpers/machine-store.js';

type Write = (input: { bucket: R2Bucket; owner: LedgerPort; identity: Identity; toolInputId: string; declaration: typeof DECLARATION; body: ReadableStream<Uint8Array> }) => Promise<{ ok: boolean; status: number }>;
const write = (writeModule as unknown as { writeVideoSourceLedger: Write }).writeVideoSourceLedger;

/**
 * Observe the port's calls while keeping the real store behind it.
 * @param port - The real port.
 * @returns The observed port.
 */
function observed(port: LedgerPort): LedgerPort & { calls: { claim: Mock<LedgerPort['claimSourceLedger']>; commit: Mock<LedgerPort['commitLedger']>; release: Mock<LedgerPort['releaseSourceLedger']> } } {
  const claim = vi.fn<LedgerPort['claimSourceLedger']>((identity, toolInputId, declaration) => port.claimSourceLedger(identity, toolInputId, declaration));
  const commit = vi.fn<LedgerPort['commitLedger']>((identity, toolInputId, owner, measured) => port.commitLedger(identity, toolInputId, owner, measured));
  const release = vi.fn<LedgerPort['releaseSourceLedger']>((identity, toolInputId, owner) => port.releaseSourceLedger(identity, toolInputId, owner));
  return { claimSourceLedger: claim, commitLedger: commit, releaseSourceLedger: release, calls: { claim, commit, release } };
}

/**
 * Wait past a synthetic deadline.
 * @param deadlineAt - The deadline.
 */
async function passDeadline(deadlineAt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineAt - Date.now() + 5)));
}

/**
 * The receipt the store holds for T after a real write.
 * @param key - The source key.
 * @returns The receipt.
 */
async function writtenReceipt(key: string): Promise<Record<string, unknown>> {
  const object = await env.BUCKET.head(fullKeyFor(key, T));
  const table = await env.BUCKET.head(tableKeyFor(key, T));
  return expectedReceipt(key, 'job-a', { etag: object!.etag, size: object!.size, sha256: await digest(FULL), table: { etag: table!.etag, size: table!.size, sha256: await digest(TABLE) } });
}

describe('ledger R2 publication (inner#1306 §7.3, §7.4)', () => {
  it('W01 splits the one producer write into the compact and full objects, each with fixed MIME and the original owner metadata', async () => {
    const { key, identity } = await ledgerCase();
    expect(await write({ bucket: env.BUCKET, owner: ledgerPort(key), identity, toolInputId: T, declaration: DECLARATION, body: stream(LEDGER_BODY) })).toEqual({ ok: true, status: 200 });
    const full = await env.BUCKET.get(fullKeyFor(key, T));
    const table = await env.BUCKET.get(tableKeyFor(key, T));
    expect(new Uint8Array(await full!.arrayBuffer())).toEqual(FULL);
    expect(new Uint8Array(await table!.arrayBuffer())).toEqual(TABLE);
    expect(full!.httpMetadata?.contentType).toBe('application/json');
    expect(full!.customMetadata?.sourceLedgerJobId).toBe('job-a');
    expect(table!.customMetadata).toEqual(full!.customMetadata);
    expect((await withStore(key, (store) => store.read(key, H))).ledgers[T]).toEqual({ kind: 'ready', receipt: await writtenReceipt(key) });
  });

  it('cancels a body from a job that is not the writer before any R2 side effect', async () => {
    const { key, identity } = await ledgerCase();
    const canceled = vi.fn();
    expect(await write({ bucket: env.BUCKET, owner: ledgerPort(key), identity: { ...identity, jobId: 'job-x' }, toolInputId: T, declaration: DECLARATION, body: stream(LEDGER_BODY, canceled) })).toEqual({ ok: false, status: 409 });
    expect(canceled).toHaveBeenCalledOnce();
    expect(await env.BUCKET.head(fullKeyFor(key, T))).toBeNull();
  });

  it.each(['short', 'long'] as const)('rejects a %s stream and releases its claim without a commit', async (shape) => {
    const { key, identity } = await ledgerCase();
    const port = observed(ledgerPort(key));
    const bytes = shape === 'short' ? LEDGER_BODY.slice(0, -1) : new Uint8Array([...LEDGER_BODY, 1]);
    await expect(write({ bucket: env.BUCKET, owner: port, identity, toolInputId: T, declaration: DECLARATION, body: stream(bytes) })).rejects.toThrow();
    expect(port.calls.claim).toHaveBeenCalledOnce();
    expect(port.calls.commit).not.toHaveBeenCalled();
    expect(port.calls.release).toHaveBeenCalledOnce();
    expect(await env.BUCKET.head(fullKeyFor(key, T))).toBeNull();
    expect((await withStore(key, (store) => store.read(key, H))).ledgers[T]!.kind).toBe('pending');
  });

  it('replays a completed receipt without a PUT or a version change', async () => {
    const { key, identity } = await ledgerCase();
    await write({ bucket: env.BUCKET, owner: ledgerPort(key), identity, toolInputId: T, declaration: DECLARATION, body: stream(LEDGER_BODY) });
    const etag = (await env.BUCKET.head(fullKeyFor(key, T)))!.etag;
    const canceled = vi.fn();
    expect(await write({ bucket: env.BUCKET, owner: ledgerPort(key), identity, toolInputId: T, declaration: DECLARATION, body: stream(LEDGER_BODY, canceled) })).toEqual({ ok: false, status: 409 });
    expect(canceled).toHaveBeenCalledOnce();
    expect((await env.BUCKET.head(fullKeyFor(key, T)))!.etag).toBe(etag);
  });

  it('recovers the real complete objects on read after the commit call failed', async () => {
    const { key, identity } = await ledgerCase();
    const port = observed(ledgerPort(key));
    port.calls.commit.mockImplementationOnce(() => Promise.reject(new Error('Injected commit RPC unavailable')));
    await expect(write({ bucket: env.BUCKET, owner: port, identity, toolInputId: T, declaration: DECLARATION, body: stream(LEDGER_BODY) })).rejects.toThrow('Injected commit RPC unavailable');
    expect((await withStore(key, (store) => store.read(key, H))).ledgers[T]).toEqual({ kind: 'ready', receipt: await writtenReceipt(key) });
  });

  it('keeps a committed receipt after its acknowledgement is lost', async () => {
    const { key, identity } = await ledgerCase();
    const port = observed(ledgerPort(key));
    port.calls.commit.mockImplementationOnce(async (...args) => {
      expect(await ledgerPort(key).commitLedger(...args)).toBe(true);
      throw new Error('Injected commit ACK lost');
    });
    await expect(write({ bucket: env.BUCKET, owner: port, identity, toolInputId: T, declaration: DECLARATION, body: stream(LEDGER_BODY) })).rejects.toThrow('Injected commit ACK lost');
    expect((await withStore(key, (store) => store.read(key, H))).ledgers[T]).toEqual({ kind: 'ready', receipt: await writtenReceipt(key) });
  });

  it('rechecks the deadline when a claim begun before it returns after it', async () => {
    const { key, identity } = await ledgerCase(Date.now() + 2000);
    const port = observed(ledgerPort(key));
    port.calls.claim.mockImplementationOnce(async (...args) => {
      const claim = await ledgerPort(key).claimSourceLedger(...args);
      expect(claim).not.toBeNull();
      await passDeadline(identity.deadlineAt);
      return claim;
    });
    const canceled = vi.fn();
    expect(await write({ bucket: env.BUCKET, owner: port, identity, toolInputId: T, declaration: DECLARATION, body: stream(LEDGER_BODY, canceled) })).toEqual({ ok: false, status: 409 });
    expect(canceled).toHaveBeenCalledOnce();
    expect(port.calls.commit).not.toHaveBeenCalled();
    expect(await env.BUCKET.head(fullKeyFor(key, T))).toBeNull();
  });

  it('completes a flow that started before the deadline even when the job expires meanwhile', async () => {
    const { key, identity } = await ledgerCase(Date.now() + 2000);
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      await passDeadline(identity.deadlineAt);
      await withStore(key, (store) => store.fail(identity, 'expired'));
      controller.enqueue(LEDGER_BODY); controller.close();
    } }, { highWaterMark: 0 });
    expect(await write({ bucket: env.BUCKET, owner: ledgerPort(key), identity, toolInputId: T, declaration: DECLARATION, body })).toEqual({ ok: true, status: 200 });
    const view = await withStore(key, (store) => store.read(key, H));
    expect(view.ledgers[T]!.kind).toBe('ready');
    expect(view.candidate).toMatchObject({ jobId: 'job-a', state: 'failed', failure: 'expired' });
  });
});
