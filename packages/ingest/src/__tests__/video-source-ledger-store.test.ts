// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor, videoSourceLedgerKeyFor } from '@breatic/shared';
import { fixture, LEDGER_LIMITS, ORIGINAL, PRICING, putClaim, receipt, replacement } from './helpers/source-ledger-fixture.js';
import { writeAlphaPacked } from '@ingest/video-presentation-packed.js';

const evidence = { codecName: 'vp9', pixelFormat: 'yuv420p', pixelAlpha: 0 as const, alphaMode: null, formatName: 'matroska,webm', videoStreamIndex: 0 };

describe('source-ledger durable capability and independent siblings (inner#1306)', () => {
  it('A04 persists pending capability under the original job and freezes all requested limits on replay', async () => {
    const value = await fixture();
    const before = await value.owner.snapshotFor(value.identity);
    expect(before.sourceLedger).toEqual({ state: 'pending', schemaVersion: 1, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 1,
      attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt } });
    const replay = await value.owner.accept({ ...value.admission, jobId: 'later-proposal', deadlineAt: value.identity.deadlineAt + 1000,
      limits: { ...value.admission.limits!, sourceLedger: { ...LEDGER_LIMITS, maxBytes: 1 } } });
    expect(replay).toEqual(before);
    const prepared = await value.owner.prepare(value.identity);
    expect(prepared.token).toBe(value.identity.token);
    expect(prepared.admission?.limits?.sourceLedger).toEqual(LEDGER_LIMITS);
  });

  it('A04 replays active legacy work without silently adding a new capability or budgets', async () => {
    const value = await fixture({ requested: false });
    const before = await value.owner.snapshotFor(value.identity);
    const replay = await value.owner.accept({ ...value.admission, jobId: 'new-capability-proposal',
      sourceLedgerURL: `https://assets.example.test/${videoSourceLedgerKeyFor(value.admission.storageKey)}`,
      limits: { ...value.admission.limits!, sourceLedger: LEDGER_LIMITS } });
    expect(replay).toEqual(before);
    expect(Object.hasOwn(replay, 'sourceLedger')).toBe(false);
    expect((await value.owner.prepare(value.identity)).admission?.limits?.sourceLedger).toBeUndefined();
  });

  it('A05 keeps the actual native descriptor producer A while admitting terminal missing-capability work B', async () => {
    const value = await fixture({ requested: false });
    expect(await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL, evidence })).toBe(true);
    const before = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    const descriptor = await (await env.BUCKET.get(videoPresentationKeyFor(value.admission.storageKey)))!.text();
    const admission = { ...value.admission, jobId: 'ledger-only-B', sourceLedgerURL: `https://assets.example.test/${videoSourceLedgerKeyFor(value.admission.storageKey)}`,
      limits: { ...value.admission.limits!, sourceLedger: LEDGER_LIMITS } };
    const accepted = await value.owner.accept(admission);
    expect(accepted.presentation).toEqual(before.presentation);
    expect(accepted.attempt).toEqual({ jobId: 'ledger-only-B', deadlineAt: value.identity.deadlineAt, status: 'accepted', usage: null });
    expect(accepted.sourceLedger).toEqual({ state: 'pending', schemaVersion: 1, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 1,
      attempt: { jobId: 'ledger-only-B', deadlineAt: value.identity.deadlineAt } });
    expect((await value.owner.prepare(admission)).admission?.ledgerOnly).toBe(true);
    expect(await value.owner.snapshotFor(value.identity)).toEqual(before);
    expect(await (await env.BUCKET.get(videoPresentationKeyFor(value.admission.storageKey)))!.text()).toBe(descriptor);
  });

  it('does not mark requested combined work complete merely because its native descriptor is ready', async () => {
    const value = await fixture();
    expect(await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL, evidence })).toBe(true);
    const read = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(read.presentation).toMatchObject({ state: 'native', attempt: { jobId: value.identity.jobId } });
    expect(read.attempt).toEqual({ jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt, status: 'running', usage: null });
    expect(read.sourceLedger?.state).toBe('pending');
  });

  it('A05/A07 preserves original alpha-ready descriptor and manifest when ledger-only B fails', async () => {
    const value = await fixture({ requested: false, knownAlpha: true });
    await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_alpha', original: ORIGINAL,
      evidence: { codecName: 'prores', pixelFormat: 'yuva444p12le', pixelAlpha: 1, alphaMode: null, formatName: 'mov', videoStreamIndex: 0 } });
    await value.owner.report({ ...value.identity, kind: 'encoded', packedWidth: 192, packedHeight: 64,
      colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } });
    const packed = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(packed); controller.close(); } });
    expect(await writeAlphaPacked({ bucket: env.BUCKET, owner: value.owner, identity: value.identity, body, byteLength: packed.length })).toEqual({ ok: true, status: 200 });
    const before = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    const descriptor = await (await env.BUCKET.get(videoPresentationKeyFor(value.admission.storageKey)))!.text();
    const admission = { ...value.admission, jobId: 'alpha-ledger-only-B', sourceLedgerURL: `https://assets.example.test/${videoSourceLedgerKeyFor(value.admission.storageKey)}`,
      limits: { ...value.admission.limits!, sourceLedger: LEDGER_LIMITS } };
    await value.owner.accept(admission);
    const prepared = await value.owner.prepare(admission);
    expect(prepared.admission?.ledgerOnly).toBe(true);
    const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
    expect(await value.owner.report({ ...identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(true);
    const read = await value.owner.read(admission.storageKey, identity.sourceFingerprint);
    expect(read.presentation).toEqual(before.presentation);
    expect(read.manifest).toEqual(before.manifest);
    expect(read.sourceLedger).toEqual({ state: 'failed', schemaVersion: 1, sourceFingerprint: identity.sourceFingerprint, producerVersion: 1,
      attempt: { jobId: identity.jobId, deadlineAt: identity.deadlineAt }, errorCode: 'source_ledger_invalid' });
    expect(await (await env.BUCKET.get(videoPresentationKeyFor(admission.storageKey)))!.text()).toBe(descriptor);
  });

  it('A06 retains the exact completed ledger receipt when the original alpha work reports packed_clock_mismatch', async () => {
    const value = await fixture({ knownAlpha: true });
    const claim = await value.owner.claimSourceLedger(value.identity, value.declaration);
    expect(claim).not.toBeNull();
    const measured = await putClaim(value, claim!);
    expect(await value.owner.completeSourceLedger(value.identity, claim!.owner, measured)).toBe(true);
    await value.owner.report({ ...value.identity, kind: 'finished', usage: { wallMs: 250, cpuUsec: 10 }, error: 'packed_clock_mismatch' });
    const read = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(read.sourceLedger).toEqual({ state: 'ready', receipt: receipt(value, measured) });
    expect(read.presentation).toMatchObject({ state: 'failed', error: 'packed_clock_mismatch' });
    expect(read.usageFact).toEqual({ jobId: value.identity.jobId, actorUserId: value.admission.actorUserId, projectId: null,
      usage: { wallMs: 250, cpuUsec: 10 }, pricing: PRICING });
  });

  it('keeps both ready capabilities running until actual finished and preserves one exact usage fact on replay', async () => {
    const value = await fixture();
    await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL, evidence });
    const claim = await value.owner.claimSourceLedger(value.identity, value.declaration);
    expect(claim).not.toBeNull();
    const measured = await putClaim(value, claim!);
    expect(await value.owner.completeSourceLedger(value.identity, claim!.owner, measured)).toBe(true);
    const unfinalized = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(unfinalized.attempt).toEqual({ jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt, status: 'running', usage: null });
    expect(unfinalized.sourceLedger).toEqual({ state: 'ready', receipt: receipt(value, measured) });
    const finished = { ...value.identity, kind: 'finished' as const, usage: { wallMs: 123, cpuUsec: 0 } };
    expect(await value.owner.report(finished)).toBe(true);
    const before = await value.owner.snapshotFor(value.identity);
    expect(before.attempt).toMatchObject({ status: 'completed', usage: { wallMs: 123, cpuUsec: 0 } });
    expect(await value.owner.report(finished)).toBe(true);
    expect(await value.owner.report({ ...finished, usage: { wallMs: 124, cpuUsec: 0 } })).toBe(false);
    expect(await value.owner.snapshotFor(value.identity)).toEqual(before);
  });

  it('retains a ready native descriptor while source-ledger failure and real final usage settle independently', async () => {
    const value = await fixture();
    await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL, evidence });
    const presentation = (await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint)).presentation;
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(true);
    expect(await value.owner.report({ ...value.identity, kind: 'finished', usage: { wallMs: 123, cpuUsec: null } })).toBe(true);
    const read = await value.owner.acknowledgeUsage(value.identity);
    expect(read.presentation).toEqual(presentation);
    expect(read.sourceLedger).toEqual({ state: 'failed', schemaVersion: 1, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 1,
      attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt }, errorCode: 'source_ledger_invalid' });
    expect(read.attempt).toMatchObject({ status: 'failed', usage: { wallMs: 123, cpuUsec: null }, usageRecorded: true });
    expect(read.usageFact).toEqual({ jobId: value.identity.jobId, actorUserId: value.admission.actorUserId, projectId: null,
      usage: { wallMs: 123, cpuUsec: null }, pricing: PRICING });
    expect(await value.owner.accept({ ...value.admission, jobId: 'ordinary-poll-must-not-mint' })).toEqual(read);
  });

  it('A08 rejects stale new claims and reports without changing current B', async () => {
    const value = await fixture();
    const fresh = await replacement(value);
    const before = await fresh.owner.snapshotFor(fresh.identity);
    expect(await value.owner.claimSourceLedger(value.identity, value.declaration)).toBeNull();
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(false);
    expect(await fresh.owner.snapshotFor(fresh.identity)).toEqual(before);
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  });

  it('returns archived A actual usage after fail/expire is called for A while B is current', async () => {
    const value = await fixture();
    const fresh = await replacement(value);
    const before = await fresh.owner.snapshotFor(fresh.identity);
    expect(await value.owner.report({ ...value.identity, kind: 'finished', usage: { wallMs: 777, cpuUsec: 17 } })).toBe(true);
    const original = await value.owner.acknowledgeUsage(value.identity);
    expect(await value.owner.fail(value.identity, 'expired')).toEqual(original);
    expect(original.usageFact).toMatchObject({ jobId: value.identity.jobId, usage: { wallMs: 777, cpuUsec: 17 } });
    expect((await value.owner.prepare(value.identity)).admission).toBeNull();
    expect(await fresh.owner.snapshotFor(fresh.identity)).toEqual(before);
  });

  it.each(['jobId', 'sourceFingerprint', 'deadlineAt', 'token'] as const)('checks original %s before a new source-ledger claim', async (field) => {
    const value = await fixture();
    const altered = { ...value.identity, [field]: field === 'deadlineAt' ? value.identity.deadlineAt + 1 : field === 'sourceFingerprint' ? 'b'.repeat(64) : 'not-original' };
    const before = await value.owner.snapshotFor(value.identity);
    expect(await value.owner.claimSourceLedger(altered, value.declaration)).toBeNull();
    expect(await value.owner.snapshotFor(value.identity)).toEqual(before);
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  });

  it('permits only one durable current writer and derives its key from the actual canonical source', async () => {
    const value = await fixture();
    const claims = await Promise.all([value.owner.claimSourceLedger(value.identity, value.declaration), value.owner.claimSourceLedger(value.identity, value.declaration)]);
    expect(claims.filter(claim => claim !== null)).toHaveLength(1);
    expect(claims.find(claim => claim !== null)).toEqual({ owner: expect.any(String), key: videoSourceLedgerKeyFor(value.admission.storageKey), priorETag: null, byteLength: value.bytes.length });
  });

  it.each([
    { field: 'producerVersion', value: 2 }, { field: 'byteLength', value: 0 }, { field: 'byteLength', value: 16777217 },
    { field: 'physicalFrameCount', value: 0 }, { field: 'physicalFrameCount', value: 100001 },
    { field: 'occurrenceCount', value: -1 }, { field: 'occurrenceCount', value: 100001 },
  ])('refuses an inadmissible $field declaration $value before a physical mutation', async ({ field, value: invalid }) => {
    const value = await fixture();
    const before = await value.owner.snapshotFor(value.identity);
    expect(await value.owner.claimSourceLedger(value.identity, { ...value.declaration, [field]: invalid })).toBeNull();
    expect(await value.owner.snapshotFor(value.identity)).toEqual(before);
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  });

  it('admits a zero-occurrence declaration without fabricating a physical publication', async () => {
    const value = await fixture();
    // This is declaration validation only; no claim that N01 produced an empty schedule.
    const claim = await value.owner.claimSourceLedger(value.identity, { ...value.declaration, occurrenceCount: 0 });
    expect(claim).toEqual({ owner: expect.any(String), key: videoSourceLedgerKeyFor(value.admission.storageKey), priorETag: null, byteLength: value.bytes.length });
    await value.owner.releaseSourceLedger(value.identity, claim!.owner);
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  });
});
