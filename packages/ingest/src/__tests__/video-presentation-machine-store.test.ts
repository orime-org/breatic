// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * S6c wiring: the presentation Durable Object store over the seven pure
 * transitions (inner#1306, test plan §89; frames-split design §7.1–§7.4 write
 * points and arbitration). Real workerd Durable Object storage and real R2.
 *
 * The candidate is written only through `advancePresentationCandidate`; P only
 * through `commitPresentationVersion`, which conditionally replaces the R2
 * current descriptor (R0) before the DO copy; L ready only through
 * `commitLedger`, failed only through `failLedger`; Tp comes before any ledger
 * write and decides the one writer per toolInputId; `accept` archives the old job
 * and hands its writing over in the same transaction; only the latest chunk
 * attempt moves its chunk.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor } from '@breatic/shared';
import { fullKeyFor, tableKeyFor } from './helpers/source-ledger-fixture.js';
import { admission, bundle, D, DECLARATION, H, NOW, PLAN, planned, produceLedger, putLedger, source, started, storedDescriptor, T, T2, withStore, type Identity, type MachineStore } from './helpers/machine-store.js';

/**
 * Admit and start a second job after the first.
 * @param store - The store.
 * @param key - The storage key.
 * @param jobId - The new job.
 * @returns Its identity.
 */
async function next(store: MachineStore, key: string, jobId: string): Promise<Identity> {
  await store.accept(admission(key, jobId));
  const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId, deadlineAt: D }, NOW);
  return { storageKey: key, sourceFingerprint: H, jobId, deadlineAt: D, token: token! };
}

/**
 * Select version e of toolInputId T2 for job a, then let job b plan T and verify f, so that b waits for L(T).
 * @param store - The store.
 * @param key - The storage key.
 * @returns Job b.
 */
async function waitingOnNewLedger(store: MachineStore, key: string): Promise<Identity> {
  const a = await planned(store, key, 'job-a', 'identity', T2);
  await produceLedger(store, a, T2);
  await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64), T2) });
  const b = await next(store, key, 'job-b');
  await store.planPresentation(b, { route: 'identity', toolInputId: T, planSha256: PLAN });
  const view = await store.report(b, { kind: 'verified', bundle: await bundle(key, 'f'.repeat(64)) });
  expect(view.candidate.state).toBe('verified');
  expect(view.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T2 } });
  return b;
}

describe('W §7.1–§7.4 store persistence and write points', () => {
  it('W01 the candidate, its frozen route and pinned toolInputId persist across store instances', async () => {
    const key = await source();
    await withStore(key, (store) => planned(store, key, 'job-a'));
    const view = await withStore(key, (store) => store.read(key, H));
    expect(view.candidate).toMatchObject({ state: 'building', jobId: 'job-a', route: 'encode', stage: 'plan', toolInputId: T, pinned: true });
    expect(view.selected).toEqual({ kind: 'unknown' });
    expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
  });

  it('W02 Tp comes before any ledger write: no claim before the plan, the writer gets one after', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const identity = await started(store, key, 'job-a');
      expect(await store.claimSourceLedger(identity, T, DECLARATION)).toBeNull();
      expect((await store.planPresentation(identity, { route: 'encode', toolInputId: T, planSha256: PLAN })).writer).toBe(true);
      expect(await store.claimSourceLedger(identity, T, DECLARATION)).toMatchObject({ key: fullKeyFor(key, T), table: { key: tableKeyFor(key, T) } });
    });
  });

  it('W03 two concurrent plans of the same job make one writer and one claim', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const identity = await started(store, key, 'job-a');
      const plans = await Promise.all([1, 2].map(() => store.planPresentation(identity, { route: 'encode', toolInputId: T, planSha256: PLAN })));
      expect(plans.every((plan) => plan.writer)).toBe(true);
      const claims = await Promise.all([1, 2].map(() => store.claimSourceLedger(identity, T, DECLARATION)));
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    });
  });

  it('W04 accept archives the old candidate and hands its writing over in the same transaction', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      const view = await store.accept(admission(key, 'job-b'));
      expect(view.archive.map((record) => ({ jobId: record.jobId, archived: record.archived, pinned: record.pinned }))).toEqual([{ jobId: 'job-a', archived: true, pinned: false }]);
      expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: true, waiters: [] });
      const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW);
      const b = { ...a, jobId: 'job-b', token: token! };
      expect((await store.planPresentation(b, { route: 'encode', toolInputId: T, planSha256: PLAN })).writer).toBe(true);
      expect(await store.claimSourceLedger(a, T, DECLARATION)).toBeNull();
      expect(await store.claimSourceLedger(b, T, DECLARATION)).not.toBeNull();
    });
  });

  it('W05 commitLedger accepts only the writer\'s measured objects and turns the instance ready', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      const claim = (await store.claimSourceLedger(a, T, DECLARATION))!;
      const measured = await putLedger(claim, 'job-a');
      expect(await store.commitLedger({ ...a, jobId: 'job-x' }, T, claim.owner, measured)).toBe(false);
      expect((await store.read(key, H)).ledgers[T]!.kind).toBe('pending');
      expect(await store.commitLedger(a, T, claim.owner, measured)).toBe(true);
      expect((await store.read(key, H)).ledgers[T]!.kind).toBe('ready');
    });
  });

  it.each(['too_long', 'packed_over_cap', 'packed_clock_mismatch'])('W06 failLedger never writes the candidate code %s into the instance', async (code) => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      await store.failLedger(a, T, code);
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
    });
  });

  it('W07 a content ledger failure fails a verified candidate waiting on it with that code', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const b = await waitingOnNewLedger(store, key);
      await store.failLedger(b, T, 'invalid_edit');
      const after = await store.read(key, H);
      expect(after.ledgers[T]).toEqual({ kind: 'failed-content', code: 'invalid_edit' });
      expect(after.candidate).toMatchObject({ state: 'failed', failure: 'invalid_edit', pinned: false });
      expect(after.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T2 } });
    });
  });

  it('W08 a verified candidate waiting on its new ledger is published when commitLedger makes it ready', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const b = await waitingOnNewLedger(store, key);
      await produceLedger(store, b);
      const after = await store.read(key, H);
      expect(after.selected).toEqual({ kind: 'ready', version: { versionId: 'f'.repeat(64), toolInputId: T } });
      expect(await storedDescriptor(key)).toEqual((await bundle(key, 'f'.repeat(64))).descriptor);
    });
  });

  it('W09 commitPresentationVersion writes the current descriptor (R0) before the DO selection', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'identity');
      const published = await bundle(key, 'e'.repeat(64));
      const view = await store.report(a, { kind: 'verified', bundle: published });
      expect(view.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T } });
      expect(await storedDescriptor(key)).toEqual(published.descriptor);
    });
  });

  it('W10 an external change of the current descriptor fails the conditional replace and leaves the DO selection unknown', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'identity');
      await env.BUCKET.put(videoPresentationKeyFor(key), JSON.stringify({ foreign: true }));
      const view = await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) });
      expect(view.selected).toEqual({ kind: 'unknown' });
      expect(await storedDescriptor(key)).toEqual({ foreign: true });
    });
  });

  it('W11 an archived candidate records its verified facts but never publishes', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'identity');
      await store.accept(admission(key, 'job-b'));
      const view = await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) });
      expect(view.archive.find((record) => record.jobId === 'job-a')).toMatchObject({ state: 'verified', archived: true });
      expect(view.selected).toEqual({ kind: 'unknown' });
      expect(await storedDescriptor(key)).toBeNull();
    });
  });

  it('W12 a candidate failure code fails the candidate and leaves its ledger instance alone', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      const view = await store.fail(a, 'too_long');
      expect(view.candidate).toMatchObject({ state: 'failed', failure: 'too_long', pinned: false });
      expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
    });
  });

  it('W13 only the latest chunk attempt moves its chunk, and after chunk_retries 3 the candidate fails with the underlying code', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      expect(await store.advanceStage(a, 'encode')).toBe(true);
      const unit = { kind: 'presentation-chunk' as const, chunk: 0 };
      await store.reportChunk(a, unit, { kind: 'Sub' });
      await store.reportChunk(a, unit, { kind: 'Fail', attempt: 1, code: 'resource_exhausted', usage: 2 });
      await store.reportChunk(a, unit, { kind: 'Done', attempt: 1, usage: 3 });
      expect((await store.read(key, H)).chunks['video-presentation:job-a:chunk:0']).toMatchObject({ state: 'open', attempt: 2, retries: 2 });
      for (const attempt of [2, 3, 4]) await store.reportChunk(a, unit, { kind: 'Fail', attempt, code: 'invalid_edit', usage: null });
      const view = await store.read(key, H);
      expect(view.chunks['video-presentation:job-a:chunk:0']).toMatchObject({ state: 'failed', attempt: 4, retries: 0, failure: 'invalid_edit' });
      expect(view.candidate).toMatchObject({ state: 'failed', failure: 'invalid_edit' });
    });
  });

  it('W14 Sg outside the frozen route is refused and leaves the stored stage', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'copy');
      expect(await store.advanceStage(a, 'encode')).toBe(false);
      expect((await store.read(key, H)).candidate.stage).toBe('plan');
    });
  });
});
