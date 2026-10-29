// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from 'cloudflare:test';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { videoSourceLedgerKeyFor } from '@breatic/shared';
import { writeVideoSourceLedger, type SourceLedgerOwner } from '@ingest/video-source-ledger-write.js';
import { fixture, receipt, stream, digest, tableKeyFor } from './helpers/source-ledger-fixture.js';

/** Observe ordinary RPC calls while retaining the actual DO implementation. @throws {never} Never. */
function ports(owner: SourceLedgerOwner): SourceLedgerOwner & { calls: {
  claim: Mock<SourceLedgerOwner['claimSourceLedger']>; complete: Mock<SourceLedgerOwner['completeSourceLedger']>; release: Mock<SourceLedgerOwner['releaseSourceLedger']>;
} } {
  const claim = vi.fn<SourceLedgerOwner['claimSourceLedger']>((identity, declaration) => owner.claimSourceLedger(identity, declaration));
  const complete = vi.fn<SourceLedgerOwner['completeSourceLedger']>((identity, nonce, measured) => owner.completeSourceLedger(identity, nonce, measured));
  const release = vi.fn<SourceLedgerOwner['releaseSourceLedger']>((identity, nonce) => owner.releaseSourceLedger(identity, nonce));
  return { claimSourceLedger: claim, completeSourceLedger: complete, releaseSourceLedger: release, calls: { claim, complete, release } };
}

/** Wait for a synthetic original deadline, without asserting a platform latency budget. @throws {never} Never. */
async function passDeadline(deadlineAt: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadlineAt - Date.now() + 5)));
}

describe('dedicated source-ledger real R2 publication (inner#1306)', () => {
  it('W01 splits the one producer write into the compact table and the full ledger, each complete with fixed MIME and original owner metadata', async () => {
    const value = await fixture();
    expect(await writeVideoSourceLedger({ bucket: env.BUCKET, owner: value.owner, identity: value.identity, declaration: value.declaration, body: stream(value.body) })).toEqual({ ok: true, status: 200 });
    const object = await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(value.bytes);
    expect(object!.httpMetadata?.contentType).toBe('application/json');
    expect(object!.customMetadata?.sourceLedgerJobId).toBe(value.identity.jobId);
    expect(object!.customMetadata?.sourceLedgerClaimOwner).toEqual(expect.any(String));
    const table = await env.BUCKET.get(tableKeyFor(value.admission.storageKey));
    expect(new Uint8Array(await table!.arrayBuffer())).toEqual(value.tableBytes);
    expect(table!.httpMetadata?.contentType).toBe('application/json');
    expect(table!.customMetadata).toEqual(object!.customMetadata);
    const measured = { etag: object!.etag, size: object!.size, sha256: await digest(value.bytes) };
    expect((await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint)).sourceLedger).toEqual({ state: 'ready', receipt: await receipt(value, measured) });
    expect(new Uint8Array(await (await env.BUCKET.get(value.admission.storageKey))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('cancels a refused legacy body before any R2 side effect', async () => {
    const value = await fixture({ requested: false });
    const canceled = vi.fn();
    expect(await writeVideoSourceLedger({ bucket: env.BUCKET, owner: value.owner, identity: value.identity, declaration: value.declaration, body: stream(value.body, canceled) })).toEqual({ ok: false, status: 409 });
    expect(canceled).toHaveBeenCalledOnce();
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  });

  it.each(['short', 'long'] as const)('rejects a %s stream and drains its original write without publishing a receipt', async (shape) => {
    const value = await fixture();
    const owner = ports(value.owner);
    const bytes = shape === 'short' ? value.body.slice(0, value.body.length - 1) : new Uint8Array([...value.body, 1]);
    await expect(writeVideoSourceLedger({ bucket: env.BUCKET, owner, identity: value.identity, declaration: value.declaration, body: stream(bytes) })).rejects.toThrow();
    expect(owner.calls.claim).toHaveBeenCalledOnce();
    expect(owner.calls.complete).not.toHaveBeenCalled();
    expect(owner.calls.release).toHaveBeenCalledOnce();
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
    expect((await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint)).sourceLedger?.state).toBe('pending');
  });

  it('A09 replays a completed physical receipt without PUT or version changes', async () => {
    const value = await fixture();
    expect(await writeVideoSourceLedger({ bucket: env.BUCKET, owner: value.owner, identity: value.identity, declaration: value.declaration, body: stream(value.body) })).toEqual({ ok: true, status: 200 });
    const before = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    const object = await env.BUCKET.head(videoSourceLedgerKeyFor(value.admission.storageKey));
    const canceled = vi.fn();
    expect(await writeVideoSourceLedger({ bucket: env.BUCKET, owner: value.owner, identity: value.identity, declaration: value.declaration, body: stream(value.body, canceled) })).toEqual({ ok: false, status: 409 });
    expect(canceled).toHaveBeenCalledOnce();
    expect(await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint)).toEqual(before);
    expect((await env.BUCKET.head(videoSourceLedgerKeyFor(value.admission.storageKey)))!.etag).toBe(object!.etag);
  });

  it('A11 recovers the real complete object after an injected complete RPC failure before delivery', async () => {
    const value = await fixture();
    const owner = ports(value.owner);
    // The RPC transport is interrupted; the real R2 and actual durable intent remain.
    owner.calls.complete.mockImplementationOnce(() => Promise.reject(new Error('Injected complete RPC unavailable')));
    await expect(writeVideoSourceLedger({ bucket: env.BUCKET, owner, identity: value.identity, declaration: value.declaration, body: stream(value.body) })).rejects.toThrow('Injected complete RPC unavailable');
    expect(owner.calls.release).toHaveBeenCalledOnce();
    const object = await env.BUCKET.head(videoSourceLedgerKeyFor(value.admission.storageKey));
    expect(object!.size).toBe(value.bytes.length);
    const measured = { etag: object!.etag, size: object!.size, sha256: await digest(value.bytes) };
    expect((await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint)).sourceLedger).toEqual({ state: 'ready', receipt: await receipt(value, measured) });
    expect((await env.BUCKET.head(videoSourceLedgerKeyFor(value.admission.storageKey)))!.etag).toBe(object!.etag);
  });

  it('A11 retains an actual committed receipt after its acknowledgement is lost', async () => {
    const value = await fixture();
    const owner = ports(value.owner);
    owner.calls.complete.mockImplementationOnce(async (identity, nonce, measured) => {
      expect(await value.owner.completeSourceLedger(identity, nonce, measured)).toBe(true);
      throw new Error('Injected complete ACK lost');
    });
    await expect(writeVideoSourceLedger({ bucket: env.BUCKET, owner, identity: value.identity, declaration: value.declaration, body: stream(value.body) })).rejects.toThrow('Injected complete ACK lost');
    const object = await env.BUCKET.head(videoSourceLedgerKeyFor(value.admission.storageKey));
    const before = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(before.sourceLedger).toEqual({ state: 'ready', receipt: await receipt(value, { etag: object!.etag, size: object!.size, sha256: await digest(value.bytes) }) });
    expect(await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint)).toEqual(before);
  });

  it('A12 rechecks D when an actual claim RPC begun before D returns after D', async () => {
    const value = await fixture({ deadlineAt: Date.now() + 2000 });
    const owner = ports(value.owner);
    owner.calls.claim.mockImplementationOnce(async (identity, declaration) => {
      const claim = await value.owner.claimSourceLedger(identity, declaration);
      expect(claim).not.toBeNull();
      await passDeadline(value.identity.deadlineAt);
      return claim;
    });
    const canceled = vi.fn();
    expect(await writeVideoSourceLedger({ bucket: env.BUCKET, owner, identity: value.identity, declaration: value.declaration, body: stream(value.body, canceled) })).toEqual({ ok: false, status: 409 });
    expect(canceled).toHaveBeenCalledOnce();
    expect(owner.calls.complete).not.toHaveBeenCalled();
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  });

  it('A11 permits full completion of a flow already started before D without an uploaded-time cutoff or work revival', async () => {
    const value = await fixture({ deadlineAt: Date.now() + 2000 });
    const owner = ports(value.owner);
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      await passDeadline(value.identity.deadlineAt);
      await value.owner.fail(value.identity, 'expired');
      controller.enqueue(value.body); controller.close();
    } }, { highWaterMark: 0 });
    expect(await writeVideoSourceLedger({ bucket: env.BUCKET, owner, identity: value.identity, declaration: value.declaration, body })).toEqual({ ok: true, status: 200 });
    const object = await env.BUCKET.head(videoSourceLedgerKeyFor(value.admission.storageKey));
    expect(object!.uploaded.getTime()).toBeGreaterThan(value.identity.deadlineAt);
    const result = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(result.sourceLedger).toEqual({ state: 'ready', receipt: await receipt(value, { etag: object!.etag, size: object!.size, sha256: await digest(value.bytes) }) });
    expect(result.attempt).toMatchObject({ jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt, status: 'failed', usage: null });
  });
});
