// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Durable presentation admission and selection over real storage and R2
 * (inner#1306, test plan §89 rewrite of the v1 store cases; frames-split design
 * §7.1 candidate, §7.2 selected bundle P, §3.1 original bytes unchanged).
 *
 * The v1 descriptor states (classifying/native/alpha_*) are gone: pending work is
 * the candidate's, and P is unknown, ready or invalid. What the design keeps: an
 * admission without measurements publishes nothing, overlapping admissions of one
 * job share one record, a replay never extends the deadline, a replaced job's late
 * facts never publish, a bundle whose objects are absent is never selected, and a
 * selected version whose stored descriptor disappeared is no longer served.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor } from '@breatic/shared';
import { admission, bundle, D, H, NOW, planned, source, SOURCE_BYTES, storedDescriptor, T, withStore } from './helpers/machine-store.js';

describe('durable presentation admission and selection (inner#1306 §7.1, §7.2)', () => {
  it('admits work before any measurement without publishing a descriptor or changing the original object', async () => {
    const key = await source();
    const view = await withStore(key, (store) => store.accept({ ...admission(key, 'job-a'), original: null }));
    expect(view.candidate).toMatchObject({ state: 'accepted', jobId: 'job-a', deadlineAt: D });
    expect(view.selected).toEqual({ kind: 'unknown' });
    expect(await storedDescriptor(key)).toBeNull();
    expect(new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer())).toEqual(SOURCE_BYTES);
  });

  it('two overlapping admissions of one job share one candidate', async () => {
    const key = await source();
    const views = await withStore(key, (store) => Promise.all([store.accept(admission(key, 'job-a')), store.accept(admission(key, 'job-a'))]));
    expect(views.map((view) => view.candidate.jobId)).toEqual(['job-a', 'job-a']);
    expect((await withStore(key, (store) => store.read(key, H))).archive).toEqual([]);
  });

  it('a replay with a later proposed deadline keeps the first accepted deadline', async () => {
    const key = await source();
    await withStore(key, (store) => store.accept(admission(key, 'job-a')));
    const view = await withStore(key, (store) => store.accept(admission(key, 'job-a', D + 7_200_000)));
    expect(view.candidate.deadlineAt).toBe(D);
  });

  it('a replaced failed job that finishes later never publishes', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'reuse');
      await store.fail(a, 'expired');
      await store.accept(admission(key, 'job-b'));
      const view = await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) });
      expect(view.selected).toEqual({ kind: 'unknown' });
      expect(view.candidate.jobId).toBe('job-b');
    });
    expect(await storedDescriptor(key)).toBeNull();
  });

  it('a bundle whose carrier object is absent is not selected', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'reuse');
      const published = await bundle(key, 'e'.repeat(64));
      const carrier = (published.descriptor.playback as { carrier: Record<string, unknown> }).carrier;
      carrier.storageKey = `${key}.missing-carrier.mp4`;
      const view = await store.report(a, { kind: 'verified', bundle: published });
      expect(view.selected).toEqual({ kind: 'unknown' });
    });
    expect(await storedDescriptor(key)).toBeNull();
  });

  it('a selected version whose stored descriptor disappeared reads as invalid, not as a cached ready', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await planned(store, key, 'job-a', 'reuse');
      expect((await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) })).selected.kind).toBe('ready');
    });
    await env.BUCKET.delete(videoPresentationKeyFor(key));
    const view = await withStore(key, (store) => store.read(key, H));
    expect(view.selected).toEqual({ kind: 'invalid', version: { versionId: 'e'.repeat(64), toolInputId: T } });
  });

  it('prepare starts building only for the current job before its deadline', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await store.accept(admission(key, 'job-a'));
      expect((await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: D }, D)).token).toBeNull();
      expect((await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-x', deadlineAt: D }, NOW)).token).toBeNull();
      const started = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: D }, NOW);
      expect(started.token).toEqual(expect.any(String));
      expect(started.view.candidate).toMatchObject({ state: 'building', stage: 'plan' });
    });
  });
});
