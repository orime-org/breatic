// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The presentation Durable Object store over the pure transitions (inner#1306, test plan §66; frames-split design §7.1–§7.3
 * write points and arbitration). Real workerd Durable Object storage and real R2.
 *
 * The candidate is written only through `advancePresentationCandidate`; P only through `commitPresentationVersion`, which
 * conditionally replaces the R2 current descriptor (R0) before the DO copy; `accept` archives the old job in the same
 * transaction; only the latest chunk attempt moves its chunk.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor } from '@breatic/shared';
import { presentationSnapshot } from '@ingest/video-presentation-store.js';
import { admission, bundle, D, H, planned, source, storedDescriptor, T, withStore, type Identity, type MachineStore } from './helpers/machine-store.js';

describe('W §7.1–§7.4 store persistence and write points', () => {
  it('W01 the candidate, its frozen route and pinned toolInputId persist across store instances', async () => {
    const key = await source();
    await withStore(key, (store) => planned(store, key, 'job-a'));
    const view = await withStore(key, (store) => store.read(key, H));
    expect(view.candidate).toMatchObject({ state: 'building', jobId: 'job-a', route: 'encode', stage: 'plan', toolInputId: T, pinned: true });
    expect(view.selected).toEqual({ kind: 'unknown' });
  });

  it('W04 accept archives the old candidate in the same transaction, and the archived job can no longer advance', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      const view = await store.accept(admission(key, 'job-b'));
      expect(view.archive.map((record) => ({ jobId: record.jobId, archived: record.archived, pinned: record.pinned }))).toEqual([{ jobId: 'job-a', archived: true, pinned: false }]);
      expect(await store.advanceStage(a, 'count')).toBe(false);
    });
  });

  it('W09 commitPresentationVersion writes the current descriptor (R0) before the DO selection', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'reuse');
      const published = await bundle(key, 'e'.repeat(64));
      const view = await store.report(a, { kind: 'verified', bundle: published });
      expect(view.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T } });
      expect(await storedDescriptor(key)).toEqual(published.descriptor);
    });
  });

  it('W10 an external change of the current descriptor fails the conditional replace and leaves the DO selection unknown', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'reuse');
      await env.BUCKET.put(videoPresentationKeyFor(key), JSON.stringify({ foreign: true }));
      const view = await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) });
      expect(view.selected).toEqual({ kind: 'unknown' });
      expect(await storedDescriptor(key)).toEqual({ foreign: true });
    });
  });

  it('W11 an archived candidate records its verified facts but never publishes', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'reuse');
      await store.accept(admission(key, 'job-b'));
      const view = await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) });
      expect(view.archive.find((record) => record.jobId === 'job-a')).toMatchObject({ state: 'verified', archived: true });
      expect(view.selected).toEqual({ kind: 'unknown' });
      expect(await storedDescriptor(key)).toBeNull();
    });
  });

  it('W12 a candidate failure code fails the candidate and unpins it', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      const view = await store.fail(a, 'too_long');
      expect(view.candidate).toMatchObject({ state: 'failed', failure: 'too_long', pinned: false });
    });
  });

  it('W13 only the latest chunk attempt moves its chunk, and after chunk_retries 3 the candidate fails with the underlying code', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      expect(await store.advanceStage(a, 'count')).toBe(true);
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
      const a = await planned(store, key, 'job-a');
      // The encode route has no edit stage, and its encode stage comes only after the count.
      expect(await store.advanceStage(a, 'edit')).toBe(false);
      expect(await store.advanceStage(a, 'encode')).toBe(false);
      expect((await store.read(key, H)).candidate.stage).toBe('plan');
    });
  });
});

describe('X §7.1 a candidate nobody advances any more is settled (failure sources: presentation_failed, expired)', () => {
  it('X01 a read past D fails the unfinished current candidate `expired` and unpins it; a read before D leaves it building', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await planned(store, key, 'job-a');
      expect((await store.read(key, H, D - 1)).candidate).toMatchObject({ state: 'building', failure: null, pinned: true });
      expect((await store.read(key, H, D)).candidate).toMatchObject({ state: 'failed', failure: 'expired', pinned: false });
    });
    expect((await withStore(key, (store) => store.read(key, H, D - 1))).candidate).toMatchObject({ state: 'failed', failure: 'expired' });
  });

  it('X03 abandon fails the current unfinished candidate `presentation_failed` by its job id alone; a second abandon keeps the first failure', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await planned(store, key, 'job-a');
      const ref = { storageKey: key, sourceFingerprint: H, jobId: 'job-a' };
      expect((await store.abandon(ref)).candidate).toMatchObject({ state: 'failed', failure: 'presentation_failed', pinned: false });
      expect((await store.abandon(ref)).candidate).toMatchObject({ state: 'failed', failure: 'presentation_failed' });
    });
  });

  it('X04 abandon leaves an already failed candidate, an archived job and an unknown job as they are', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a');
      await store.fail(a, 'too_long');
      expect((await store.abandon({ storageKey: key, sourceFingerprint: H, jobId: 'job-a' })).candidate).toMatchObject({ state: 'failed', failure: 'too_long' });
      await store.accept(admission(key, 'job-b'));
      const view = await store.abandon({ storageKey: key, sourceFingerprint: H, jobId: 'job-a' });
      expect(view.candidate).toMatchObject({ state: 'accepted', jobId: 'job-b', failure: null });
      expect((await store.abandon({ storageKey: key, sourceFingerprint: H, jobId: 'job-z' })).candidate).toMatchObject({ state: 'accepted', jobId: 'job-b' });
    });
  });
});

/** The store methods that settle attempts after the candidate ended, which MachineStore does not name. */
interface SettlingStore {
  recordChunkUsage: (ref: { storageKey: string; sourceFingerprint: string; jobId: string }, unit: { kind: 'presentation-chunk'; chunk: number }, attempt: number, usage: number) => Promise<boolean>;
  prepareAnswer: (ref: { storageKey: string; sourceFingerprint: string; jobId: string }, now: number) => Promise<{ capability: unknown; preparation: { failure: string | null } | null }>;
}
type Attempts = { attempts: { attempt: number; state: string; failure: string | null; usage: number | null; usageRecorded: boolean }[] };

/**
 * Plan a job and open both playback chunks, chunk 0 with no retry left after three failures.
 * @param store - The store.
 * @param key - The source key.
 * @returns The job's capability.
 */
async function twoOpenChunks(store: MachineStore, key: string): Promise<Identity> {
  const a = await planned(store, key, 'job-a');
  for (const chunk of [0, 1]) expect(await store.reportChunk(a, { kind: 'presentation-chunk', chunk }, { kind: 'Sub' })).toBe(true);
  for (const attempt of [1, 2, 3]) await store.reportChunk(a, { kind: 'presentation-chunk', chunk: 0 }, { kind: 'Fail', attempt, code: 'tool_failed', usage: 5 });
  return a;
}

/**
 * The attempts of one unit of job-a.
 * @param store - The store.
 * @param key - The source key.
 * @param chunk - The playback chunk.
 * @returns Its attempts.
 */
async function attemptsOf(store: MachineStore, key: string, chunk: number): Promise<Attempts['attempts']> {
  return ((await store.read(key, H, D - 1)).chunks[`video-presentation:job-a:chunk:${chunk}`] as unknown as Attempts).attempts;
}

// frames-split §7.1.1 Exp row: the candidate's end turns every open unit failed(expired), its pending attempts with it, so
// nothing is submitted for it any more; an attempt closed that way still has its late measured usage recorded (§7.6).
describe('E §7.1.1 Exp: a candidate that ends closes its open units', () => {
  it.each([
    ['a chunk using up its retries', async (store: MachineStore, _key: string, a: Identity): Promise<void> => {
      await store.reportChunk(a, { kind: 'presentation-chunk', chunk: 0 }, { kind: 'Fail', attempt: 4, code: 'tool_failed', usage: 5 });
    }],
    ['abandon', async (store: MachineStore, key: string): Promise<void> => { await store.abandon({ storageKey: key, sourceFingerprint: H, jobId: 'job-a' }); }],
    ['a read past D', async (store: MachineStore, key: string): Promise<void> => { await store.read(key, H, D); }],
    ['a new admission archiving it', async (store: MachineStore, key: string): Promise<void> => { await store.accept(admission(key, 'job-b')); }],
  ])('E01 %s turns the open sibling unit failed(expired) with its pending attempt', async (_name, end) => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await twoOpenChunks(store, key);
      await end(store, key, a);
      const view = await store.read(key, H, D - 1);
      expect(view.chunks['video-presentation:job-a:chunk:1']).toMatchObject({ state: 'failed', failure: 'expired' });
      expect(await attemptsOf(store, key, 1)).toEqual([expect.objectContaining({ attempt: 1, state: 'failed', failure: 'expired', usage: null, usageRecorded: false })]);
    });
  });

  it('E02 the worker\'s prepare past D fails the candidate expired and closes its open units, as a read does', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await twoOpenChunks(store, key);
      const answer = await (store as unknown as SettlingStore).prepareAnswer({ storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, D);
      expect(answer.capability).toBe(null);
      expect(answer.preparation?.failure).toBe('expired');
      expect((await store.read(key, H, D - 1)).chunks['video-presentation:job-a:chunk:1']).toMatchObject({ state: 'failed', failure: 'expired' });
    });
  });

  it('E03 an expired attempt\'s late usage is recorded by the job id alone; a still pending attempt is refused', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await twoOpenChunks(store, key);
      const ref = { storageKey: key, sourceFingerprint: H, jobId: 'job-a' };
      const settling = store as unknown as SettlingStore;
      expect(await settling.recordChunkUsage(ref, { kind: 'presentation-chunk', chunk: 1 }, 1, 700)).toBe(false);
      await store.abandon(ref);
      expect(await settling.recordChunkUsage(ref, { kind: 'presentation-chunk', chunk: 1 }, 1, 700)).toBe(true);
      expect(await settling.recordChunkUsage(ref, { kind: 'presentation-chunk', chunk: 1 }, 1, 700)).toBe(true);
      expect(await attemptsOf(store, key, 1)).toEqual([expect.objectContaining({ attempt: 1, state: 'failed', usage: 700, usageRecorded: true })]);
      // An attempt whose usage the DO already holds keeps it.
      expect(await settling.recordChunkUsage(ref, { kind: 'presentation-chunk', chunk: 0 }, 2, 999)).toBe(true);
      expect((await attemptsOf(store, key, 0)).find((item) => item.attempt === 2)).toMatchObject({ usage: 5, usageRecorded: true });
      expect(a.jobId).toBe('job-a');
    });
  });

  it('E04 the snapshot says attempt usage is outstanding while a measured attempt is unrecorded, and stops once it is', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await twoOpenChunks(store, key);
      const ref = { storageKey: key, sourceFingerprint: H, jobId: 'job-a' };
      await store.abandon(ref);
      expect(presentationSnapshot(await store.read(key, H, D - 1) as unknown as Parameters<typeof presentationSnapshot>[0], key, H)).toMatchObject({ attemptUsageOutstanding: true });
      for (const attempt of [1, 2, 3]) expect(await (store as unknown as SettlingStore).recordChunkUsage(ref, { kind: 'presentation-chunk', chunk: 0 }, attempt, 5)).toBe(true);
      expect(presentationSnapshot(await store.read(key, H, D - 1) as unknown as Parameters<typeof presentationSnapshot>[0], key, H)).not.toHaveProperty('attemptUsageOutstanding');
    });
  });
});
