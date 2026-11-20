// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import { admission, bundle, H, planned, source, storedDescriptor, T, withStore } from './helpers/machine-store.js';

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
