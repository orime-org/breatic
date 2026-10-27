// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoSourceLedgerKeyFor } from '@breatic/shared';
import type { SourceLedgerWriteClaim } from '@ingest/video-presentation-store.js';
import { digest, fixture, ORIGINAL, putClaim, receipt, replacement, type LedgerFixture } from './helpers/source-ledger-fixture.js';

/** Admit actual A/B claims against the same absent canonical version. @throws {Error} When the real owner cannot admit either original flow. */
async function race(deadlineAt?: number): Promise<{ a: LedgerFixture; b: LedgerFixture; claimA: SourceLedgerWriteClaim; claimB: SourceLedgerWriteClaim }> {
  const a = await fixture(deadlineAt === undefined ? {} : { deadlineAt });
  await a.owner.report({ ...a.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL,
    evidence: { codecName: 'vp9', pixelFormat: 'yuv420p', pixelAlpha: 0, alphaMode: null, formatName: 'matroska,webm', videoStreamIndex: 0 } });
  const claimA = await a.owner.claimSourceLedger(a.identity, a.declaration);
  expect(claimA).not.toBeNull();
  const b = await replacement(a, deadlineAt === undefined ? undefined : deadlineAt + 1);
  const claimB = await b.owner.claimSourceLedger(b.identity, b.declaration);
  expect(claimB).not.toBeNull();
  expect(claimA!.priorETag).toBe(claimB!.priorETag);
  return { a, b, claimA: claimA!, claimB: claimB! };
}

/** Retain actual B final usage while terminalizing only its failed ledger work. @throws {Error} When the original durable reports fail. */
async function failB(value: Awaited<ReturnType<typeof race>>, release = true): Promise<void> {
  if (release) await value.b.owner.releaseSourceLedger(value.b.identity, value.claimB.owner);
  expect(await value.b.owner.report({ ...value.b.identity, kind: 'source_ledger_failed', error: 'source_ledger_write_conflict' })).toBe(true);
  expect(await value.b.owner.report({ ...value.b.identity, kind: 'finished', usage: { wallMs: 311, cpuUsec: 71 } })).toBe(true);
  await value.b.owner.acknowledgeUsage(value.b.identity);
}

/** Execute the actual losing conditional PUT without substituting an R2 implementation. @throws {Error} When R2 fails. */
async function losingPut(value: LedgerFixture, claim: SourceLedgerWriteClaim): Promise<R2Object | null> {
  return env.BUCKET.put(claim.key, value.bytes, { onlyIf: claim.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.priorETag },
    httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: value.identity.jobId, sourceLedgerClaimOwner: claim.owner } });
}

describe('actual winner recovery and receipt producer identity (inner#1306)', () => {
  it('H01 reconciles actual A winner into terminal B only as the original receipt sibling', async () => {
    const value = await race();
    const measured = await putClaim(value.a, value.claimA);
    expect(await losingPut(value.b, value.claimB)).toBeNull();
    await failB(value);
    expect(await value.a.owner.completeSourceLedger(value.a.identity, value.claimA.owner, measured)).toBe(true);
    const before = await value.b.owner.snapshotFor(value.b.identity);
    expect(before.sourceLedger?.state).toBe('failed');
    const read = await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint);
    expect(read).toEqual({ ...before, sourceLedger: { state: 'ready', receipt: receipt(value.a, measured) } });
    expect(read.presentation?.attempt?.jobId).toBe(value.a.identity.jobId);
    expect(read.attempt?.jobId).toBe(value.b.identity.jobId);
    expect((await env.BUCKET.head(value.claimA.key))!.etag).toBe(measured.etag);
  });

  it('H02 preserves terminal completed legacy B while reusing the actual archived A receipt', async () => {
    const a = await fixture();
    const claim = await a.owner.claimSourceLedger(a.identity, a.declaration);
    expect(claim).not.toBeNull();
    await a.owner.fail(a.identity, 'expired');
    const { sourceLedger: _ledger, ...limits } = a.admission.limits!;
    const { sourceLedgerURL: _url, ...base } = a.admission;
    const admission = { ...base, limits, jobId: 'completed-legacy-B', repair: true };
    await a.owner.accept(admission);
    const prepared = await a.owner.prepare(admission);
    const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
    await a.owner.report({ ...identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL,
      evidence: { codecName: 'vp9', pixelFormat: 'yuv420p', pixelAlpha: 0, alphaMode: null, formatName: 'webm', videoStreamIndex: 0 } });
    await a.owner.report({ ...identity, kind: 'finished', usage: { wallMs: 200, cpuUsec: null } });
    await a.owner.acknowledgeUsage(identity);
    const before = await a.owner.snapshotFor(identity);
    expect(before.attempt?.status).toBe('completed');
    const measured = await putClaim(a, claim!);
    expect(await a.owner.completeSourceLedger(a.identity, claim!.owner, measured)).toBe(true);
    expect(await a.owner.read(admission.storageKey, identity.sourceFingerprint)).toEqual({ ...before, sourceLedger: { state: 'ready', receipt: receipt(a, measured) } });
  });

  it('H03 separates stale new mutation from the genuine original complete callback and the later read reconciliation', async () => {
    const value = await race();
    const measured = await putClaim(value.a, value.claimA);
    await failB(value);
    const before = await value.b.owner.snapshotFor(value.b.identity);
    expect(await value.a.owner.claimSourceLedger(value.a.identity, value.a.declaration)).toBeNull();
    expect(await value.a.owner.report({ ...value.a.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(false);
    expect(await value.a.owner.completeSourceLedger(value.a.identity, value.claimA.owner, measured)).toBe(true);
    expect(await value.b.owner.snapshotFor(value.b.identity)).toEqual(before);
    expect((await value.a.owner.snapshotFor(value.a.identity)).sourceLedger).toEqual({ state: 'ready', receipt: receipt(value.a, measured) });
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual({ ...before, sourceLedger: { state: 'ready', receipt: receipt(value.a, measured) } });
  });

  it('H04 keeps actual valid winner B and fences the already-issued conditional A PUT', async () => {
    const value = await race();
    const measured = await putClaim(value.b, value.claimB);
    expect(await value.b.owner.completeSourceLedger(value.b.identity, value.claimB.owner, measured)).toBe(true);
    expect(await losingPut(value.a, value.claimA)).toBeNull();
    const before = await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint);
    expect(before.sourceLedger).toEqual({ state: 'ready', receipt: receipt(value.b, measured) });
    expect(await value.a.owner.completeSourceLedger(value.a.identity, value.claimA.owner, measured)).toBe(false);
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual(before);
  });

  it('H05 blocks adoption while terminal B has a genuine active writer, then permits a separate read after release', async () => {
    const value = await race();
    const measured = await putClaim(value.a, value.claimA);
    expect(await value.a.owner.completeSourceLedger(value.a.identity, value.claimA.owner, measured)).toBe(true);
    await failB(value, false);
    const before = await value.b.owner.snapshotFor(value.b.identity);
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual(before);
    await value.b.owner.releaseSourceLedger(value.b.identity, value.claimB.owner);
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual({ ...before, sourceLedger: { state: 'ready', receipt: receipt(value.a, measured) } });
  });

  it('H06 does not infer terminality or adopt archived A while current B is running', async () => {
    const value = await race();
    const measured = await putClaim(value.a, value.claimA);
    await value.b.owner.releaseSourceLedger(value.b.identity, value.claimB.owner);
    expect(await value.a.owner.completeSourceLedger(value.a.identity, value.claimA.owner, measured)).toBe(true);
    const before = await value.b.owner.snapshotFor(value.b.identity);
    expect(before.attempt?.status).toBe('running');
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual(before);
  });

  it.each(['unknown-job', 'wrong-owner', 'wrong-size', 'wrong-mime'] as const)('H07/H08 does not attach a real object with %s provenance', async (defect) => {
    const value = await race();
    await failB(value);
    const before = await value.b.owner.snapshotFor(value.b.identity);
    const bytes = defect === 'wrong-size' ? value.a.bytes.slice(0, value.a.bytes.length - 1) : value.a.bytes;
    await env.BUCKET.put(value.claimA.key, bytes, { httpMetadata: { contentType: defect === 'wrong-mime' ? 'text/plain' : 'application/json' },
      customMetadata: { sourceLedgerJobId: defect === 'unknown-job' ? 'no-retained-original-intent' : value.a.identity.jobId,
        sourceLedgerClaimOwner: defect === 'wrong-owner' ? 'foreign-owner' : value.claimA.owner } });
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual(before);
  });

  it('H08 rejects same-size changed bytes when actual digest disagrees with original A receipt', async () => {
    const value = await race();
    const measured = await putClaim(value.a, value.claimA);
    expect(await value.a.owner.completeSourceLedger(value.a.identity, value.claimA.owner, measured)).toBe(true);
    await failB(value);
    const before = await value.b.owner.snapshotFor(value.b.identity);
    const changed = value.a.bytes.slice(); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(await digest(changed)).not.toBe(measured.sha256);
    await env.BUCKET.put(value.claimA.key, changed, { httpMetadata: { contentType: 'application/json' },
      customMetadata: { sourceLedgerJobId: value.a.identity.jobId, sourceLedgerClaimOwner: value.claimA.owner } });
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual(before);
  });

  it('H09 refuses old measurement after a real external conditional object replacement', async () => {
    const value = await fixture();
    const claim = await value.owner.claimSourceLedger(value.identity, value.declaration);
    expect(claim).not.toBeNull();
    const measured = await putClaim(value, claim!);
    const changed = value.bytes.slice(); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    const replacement = await env.BUCKET.put(claim!.key, changed, { onlyIf: { etagMatches: measured.etag }, httpMetadata: { contentType: 'application/json' },
      customMetadata: { sourceLedgerJobId: value.identity.jobId, sourceLedgerClaimOwner: claim!.owner } });
    expect(replacement!.etag).not.toBe(measured.etag);
    expect(await value.owner.completeSourceLedger(value.identity, claim!.owner, measured)).toBe(false);
    expect((await env.BUCKET.head(claim!.key))!.etag).toBe(replacement!.etag);
  });

  it('H10 reconciles an original flow completed after both deadlines, then repeats without new work or mutation', async () => {
    const value = await race(Date.now() + 2000);
    expect(Date.now()).toBeLessThan(value.a.identity.deadlineAt);
    const fixed = new FixedLengthStream(value.a.bytes.length);
    const writing = env.BUCKET.put(value.claimA.key, fixed.readable, {
      onlyIf: value.claimA.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: value.claimA.priorETag },
      httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: value.a.identity.jobId, sourceLedgerClaimOwner: value.claimA.owner },
    });
    const delayed = new ReadableStream<Uint8Array>({ async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, value.b.identity.deadlineAt - Date.now() + 5)));
      controller.enqueue(value.a.bytes); controller.close();
    } }, { highWaterMark: 0 });
    const piping = delayed.pipeTo(fixed.writable);
    await failB(value);
    const [object] = await Promise.all([writing, piping]);
    expect(object!.uploaded.getTime()).toBeGreaterThan(value.b.identity.deadlineAt);
    const measured = { etag: object!.etag, size: object!.size, sha256: await digest(value.a.bytes) };
    expect(await value.a.owner.completeSourceLedger(value.a.identity, value.claimA.owner, measured)).toBe(true);
    const once = await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint);
    expect(once.sourceLedger).toEqual({ state: 'ready', receipt: receipt(value.a, measured) });
    expect(await value.b.owner.read(value.b.admission.storageKey, value.b.identity.sourceFingerprint)).toEqual(once);
    expect((await env.BUCKET.head(videoSourceLedgerKeyFor(value.a.admission.storageKey)))!.etag).toBe(measured.etag);
  });
});
