// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The source ledger state machine of one presentation record (inner#1306
 * frames-split design §10.2, fact A; test plan §77, cases T). Each case names
 * the transition-table cell it fixes as `state×event`. The store runs over real
 * workerd Durable Object storage and real R2; no container starts.
 *
 * Failure classes come from the one shared classifier: a transient failure is
 * produced again on the next admission, a content failure is kept.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoSourceLedgerKeyFor, type VideoPresentationIngestSnapshot } from '@breatic/shared';
import { classifyVideoSourceLedgerFailure } from '@shared/upload/video-source-ledger.js';
import { fixture, ORIGINAL, putClaim, receipt, tableKeyFor, type LedgerFixture } from './helpers/source-ledger-fixture.js';

const opaque = { codecName: 'vp9', pixelFormat: 'yuv420p', pixelAlpha: 0 as const, alphaMode: null, formatName: 'matroska,webm', videoStreamIndex: 0 };

/**
 * Check the §10.2 invariants on one snapshot.
 * @param snapshot - Current record facts.
 * @param fingerprint - The record's source fingerprint.
 * @returns Nothing when every invariant holds.
 * @throws {Error} When one does not.
 */
function invariants(snapshot: VideoPresentationIngestSnapshot, fingerprint: string): void {
  const ledger = snapshot.sourceLedger;
  if (ledger?.state === 'ready') {
    expect(ledger.receipt.sourceFingerprint).toBe(fingerprint);
    expect(ledger.receipt).toHaveProperty('table');
  }
  if (ledger?.state === 'failed') expect(ledger.errorCode).toMatch(/^[a-z][a-z0-9_]*$/);
  if (ledger?.state === 'pending') expect(ledger.attempt.jobId).toBe(snapshot.attempt?.jobId);
}

/**
 * Make the fixture's presentation ready (native) without touching its ledger.
 * @param value - An accepted fixture.
 * @returns The presentation after readiness.
 * @throws {Error} When the probe is refused.
 */
async function nativeReady(value: LedgerFixture): Promise<VideoPresentationIngestSnapshot['presentation']> {
  expect(await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL, evidence: opaque })).toBe(true);
  const read = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
  expect(read.presentation?.state).toBe('native');
  return read.presentation;
}

/**
 * Write and commit both objects of the fixture's ledger through the store.
 * @param value - An accepted fixture with a pending ledger.
 * @returns The ledger measurement committed.
 * @throws {Error} When the claim or commit is refused.
 */
async function produce(value: LedgerFixture): Promise<Awaited<ReturnType<typeof putClaim>>> {
  const claim = await value.owner.claimSourceLedger(value.identity, value.declaration);
  expect(claim).not.toBeNull();
  const measured = await putClaim(value, claim!);
  expect(await value.owner.completeSourceLedger(value.identity, claim!.owner, measured)).toBe(true);
  return measured;
}

/**
 * Finish the fixture's original attempt with real usage so that it is terminal.
 * @param value - An accepted fixture.
 * @param error - The finished report's error, when the run failed.
 * @returns Nothing.
 * @throws {Error} When the report is refused.
 */
async function finish(value: LedgerFixture, error?: string): Promise<void> {
  expect(await value.owner.report({ ...value.identity, kind: 'finished', usage: { wallMs: 100, cpuUsec: 1 }, ...(error === undefined ? {} : { error }) })).toBe(true);
}

/**
 * Admit the same source again under a new job, as the next admission or the panel retry does.
 * @param value - The original fixture.
 * @param jobId - The new job id.
 * @returns The admission snapshot.
 * @throws {Error} When admission fails.
 */
function admitAgain(value: LedgerFixture, jobId: string): Promise<VideoPresentationIngestSnapshot> {
  return value.owner.accept({ ...value.admission, jobId });
}

describe('source ledger v2 state transitions (inner#1306 §10.2 fact A)', () => {
  it('T01 pending×E3 → ready: one commit names both stored objects and leaves the presentation unchanged', async () => {
    const value = await fixture();
    const presentation = await nativeReady(value);
    const measured = await produce(value);
    const read = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(read.sourceLedger).toEqual({ state: 'ready', receipt: await receipt(value, measured) });
    expect(read.sourceLedger?.state === 'ready' && read.sourceLedger.receipt.table.url).toBe(value.admission.sourceLedgerTableURL);
    expect(read.presentation).toEqual(presentation);
    invariants(read, value.identity.sourceFingerprint);
  });

  it.each(['table-missing', 'table-size', 'table-owner', 'table-mime', 'table-etag', 'ledger-missing'] as const)('T02 pending×E3 refuses a commit when %s, and stays pending', async (defect) => {
    const value = await fixture();
    await nativeReady(value);
    const claim = await value.owner.claimSourceLedger(value.identity, value.declaration);
    expect(claim).not.toBeNull();
    const measured = await putClaim(value, claim!);
    const tableKey = claim!.table.key;
    const metadata = { sourceLedgerJobId: value.identity.jobId, sourceLedgerClaimOwner: claim!.owner };
    if (defect === 'table-missing') await env.BUCKET.delete(tableKey);
    if (defect === 'ledger-missing') await env.BUCKET.delete(claim!.key);
    if (defect === 'table-size') await env.BUCKET.put(tableKey, new Uint8Array([...value.tableBytes, 32]), { httpMetadata: { contentType: 'application/json' }, customMetadata: metadata });
    if (defect === 'table-owner') await env.BUCKET.put(tableKey, value.tableBytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { ...metadata, sourceLedgerClaimOwner: 'foreign' } });
    if (defect === 'table-mime') await env.BUCKET.put(tableKey, value.tableBytes, { httpMetadata: { contentType: 'text/plain' }, customMetadata: metadata });
    const reported = defect === 'table-etag' ? { ...measured, table: { ...measured.table, etag: 'not-the-stored-etag' } } : measured;
    expect(await value.owner.completeSourceLedger(value.identity, claim!.owner, reported)).toBe(false);
    const read = await value.owner.snapshotFor(value.identity);
    expect(read.sourceLedger).toEqual({ state: 'pending', schemaVersion: 2, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 2,
      attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt } });
  });

  it.each([['missing', 'source_ledger_missing'], ['replaced', 'source_ledger_invalid']] as const)('T03 ready×E6 → failed transient when the compact table is %s, presentation unchanged', async (defect, code) => {
    const value = await fixture();
    const presentation = await nativeReady(value);
    await produce(value);
    await finish(value);
    const tableKey = tableKeyFor(value.admission.storageKey);
    if (defect === 'missing') await env.BUCKET.delete(tableKey);
    else await env.BUCKET.put(tableKey, value.tableBytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: value.identity.jobId, sourceLedgerClaimOwner: 'foreign' } });
    const read = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(read.sourceLedger).toEqual({ state: 'failed', schemaVersion: 2, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 2,
      attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt }, errorCode: code });
    expect(classifyVideoSourceLedgerFailure(code)).toBe('transient');
    expect(read.presentation).toEqual(presentation);
    invariants(read, value.identity.sourceFingerprint);
  });

  it('T04 pending×E4 transient, then failed-transient×E1 → pending under the new job as ledger-only work', async () => {
    const value = await fixture();
    const presentation = await nativeReady(value);
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(true);
    await finish(value);
    const failed = await value.owner.snapshotFor(value.identity);
    expect(failed.sourceLedger).toMatchObject({ state: 'failed', errorCode: 'source_ledger_invalid' });
    const accepted = await admitAgain(value, 'transient-retry');
    expect(accepted.sourceLedger).toEqual({ state: 'pending', schemaVersion: 2, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 2,
      attempt: { jobId: 'transient-retry', deadlineAt: value.identity.deadlineAt } });
    expect(accepted.attempt).toMatchObject({ jobId: 'transient-retry', status: 'accepted' });
    expect(accepted.presentation).toEqual(presentation);
    expect((await value.owner.prepare({ ...value.admission, jobId: 'transient-retry' })).admission?.ledgerOnly).toBe(true);
    invariants(accepted, value.identity.sourceFingerprint);
  });

  it('T05 pending×E4 content, then failed-content×E1 keeps the failure and starts no work', async () => {
    const value = await fixture();
    await nativeReady(value);
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'unsupported_rate' })).toBe(true);
    await finish(value);
    const before = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(before.sourceLedger).toEqual({ state: 'failed', schemaVersion: 2, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 2,
      attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt }, errorCode: 'unsupported_rate' });
    expect(classifyVideoSourceLedgerFailure('unsupported_rate')).toBe('content');
    expect(await admitAgain(value, 'content-retry')).toEqual(before);
    expect((await value.owner.prepare({ ...value.admission, jobId: 'content-retry' })).admission).toBeNull();
  });

  it.each([
    ['a finished report', 'finished'],
    ['a job failure', 'fail'],
  ] as const)('T06 pending×E5 via %s with a presentation failure code → failed transient, without that code, and re-produced on the next admission', async (_name, path) => {
    const value = await fixture({ knownAlpha: true });
    if (path === 'finished') await finish(value, 'packed_clock_mismatch');
    else await value.owner.fail(value.identity, 'packed_clock_mismatch');
    const read = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(read.presentation).toMatchObject({ state: 'failed', error: 'packed_clock_mismatch' });
    expect(read.sourceLedger?.state).toBe('failed');
    const code = read.sourceLedger?.state === 'failed' ? read.sourceLedger.errorCode : '';
    expect(code).not.toBe('packed_clock_mismatch');
    expect(classifyVideoSourceLedgerFailure(code)).toBe('transient');
    invariants(read, value.identity.sourceFingerprint);
    const accepted = await value.owner.accept({ ...value.admission, jobId: 'after-presentation-failure', repair: true });
    expect(accepted.sourceLedger).toMatchObject({ state: 'pending', attempt: { jobId: 'after-presentation-failure' } });
  });

  it('T07 pending×E5 expiry → failed transient expired', async () => {
    const value = await fixture();
    await value.owner.fail(value.identity, 'expired');
    const read = await value.owner.snapshotFor(value.identity);
    expect(read.sourceLedger).toEqual({ state: 'failed', schemaVersion: 2, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 2,
      attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt }, errorCode: 'expired' });
  });

  it('T08 ready×E1, ready×E4 and ready×E5 keep the ready receipt and start no work', async () => {
    const value = await fixture();
    await nativeReady(value);
    const measured = await produce(value);
    const ready = { state: 'ready', receipt: await receipt(value, measured) };
    await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' });
    expect((await value.owner.snapshotFor(value.identity)).sourceLedger).toEqual(ready);
    await value.owner.fail(value.identity, 'expired');
    expect((await value.owner.snapshotFor(value.identity)).sourceLedger).toEqual(ready);
    const before = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    expect(await admitAgain(value, 'poll-while-ready')).toEqual(before);
    expect((await value.owner.prepare({ ...value.admission, jobId: 'poll-while-ready' })).admission).toBeNull();
  });

  it('T09 failed-transient×E4 and ×E5 keep the first failure', async () => {
    const value = await fixture();
    await nativeReady(value);
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'resource_limit' })).toBe(true);
    const first = (await value.owner.snapshotFor(value.identity)).sourceLedger;
    expect(first).toMatchObject({ state: 'failed', schemaVersion: 2, errorCode: 'resource_limit' });
    await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_over_cap' });
    await value.owner.fail(value.identity, 'expired');
    expect((await value.owner.snapshotFor(value.identity)).sourceLedger).toEqual(first);
  });

  it('T10 failed-transient×E3 from the superseded job is refused once the next admission owns the source', async () => {
    const value = await fixture();
    await nativeReady(value);
    const claim = await value.owner.claimSourceLedger(value.identity, value.declaration);
    expect(claim).not.toBeNull();
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(true);
    await value.owner.releaseSourceLedger(value.identity, claim!.owner);
    await finish(value);
    const accepted = await admitAgain(value, 'superseding-job');
    expect(accepted.sourceLedger).toMatchObject({ state: 'pending', attempt: { jobId: 'superseding-job' } });
    const measured = await putClaim(value, claim!).catch(() => null);
    if (measured !== null) expect(await value.owner.completeSourceLedger(value.identity, claim!.owner, measured)).toBe(false);
    expect((await value.owner.snapshotFor({ ...value.identity, jobId: 'superseding-job' })).sourceLedger).toEqual(accepted.sourceLedger);
  });

  it('T11 one producer job per source fingerprint: concurrent admissions after a transient failure share one new attempt', async () => {
    const value = await fixture();
    await nativeReady(value);
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'expired' })).toBe(true);
    await finish(value);
    const [first, second] = await Promise.all([admitAgain(value, 'concurrent-a'), admitAgain(value, 'concurrent-b')]);
    expect(first.sourceLedger?.state).toBe('pending');
    expect(second).toEqual(first);
    const winner = first.attempt!.jobId;
    const loser = winner === 'concurrent-a' ? 'concurrent-b' : 'concurrent-a';
    expect((await value.owner.prepare({ ...value.admission, jobId: loser })).admission).toBeNull();
  });

  it('T12 pending×E8: a new source fingerprint starts a new record and the old job facts are refused', async () => {
    const value = await fixture();
    const changed = 'b'.repeat(64);
    const accepted = await value.owner.accept({ ...value.admission, sourceFingerprint: changed, jobId: 'new-source' });
    expect(accepted.sourceLedger).toEqual({ state: 'pending', schemaVersion: 2, sourceFingerprint: changed, producerVersion: 2,
      attempt: { jobId: 'new-source', deadlineAt: value.identity.deadlineAt } });
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(false);
    expect(await value.owner.claimSourceLedger(value.identity, value.declaration)).toBeNull();
    expect((await value.owner.read(value.admission.storageKey, changed)).sourceLedger).toEqual(accepted.sourceLedger);
  });

  it('T13 none×E3, none×E4 and none×E5 are refused or leave no ledger for work that never requested one', async () => {
    const value = await fixture({ requested: false });
    expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'source_ledger_invalid' })).toBe(false);
    expect(await value.owner.claimSourceLedger(value.identity, value.declaration)).toBeNull();
    await value.owner.fail(value.identity, 'expired');
    expect(Object.hasOwn(await value.owner.snapshotFor(value.identity), 'sourceLedger')).toBe(false);
    expect(await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  });
});
