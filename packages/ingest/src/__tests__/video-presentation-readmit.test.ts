// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Conditional admissions, readmit, Bad and the reuse route in the presentation DO (inner#1306 test plan §93 D6;
 * frames-split design §3.5 web→server and server/worker→ingest rows, §7.1 含义 and 路线表, §7.2 ready(A)×Bad, §7.12 item 2,
 * §10.6 失败分类).
 *
 * A discovery read or a dedup winner admits with `expect: 'first'` (still no selected P and no current candidate) or
 * `expect: 'readmit'` (the snapshot's `readmit` still true); the DO re-checks in its serial entry, answers the current
 * view without admitting when the condition fails, and admits only one of several concurrent ones. The snapshot's
 * `readmit` is true when P is invalid(V), the current candidate is V's publisher and that publisher's admission carries no
 * `readmitOf`; an admitted readmit records `readmitOf` = V's versionId, so when its own version fails again the snapshot
 * reports `preparation.failure: 'presentation_invalid'` instead of readmitting. Initialization and repair carry no
 * `expect`. Real DO storage and R2; the stored descriptor is changed or removed in R2 to make the read observe Bad.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor } from '@breatic/shared';
import { presentationSnapshot } from '@ingest/video-presentation-store.js';
import { admission, bundle, D, H, PLAN, planned, source, T, withStore, type Admission, type MachineStore, type MachineView } from './helpers/machine-store.js';

const V = 'e'.repeat(64);
const V2 = 'f'.repeat(64);
type Expect = 'first' | 'readmit';
type Snapshot = ReturnType<typeof presentationSnapshot> & { readmit?: unknown };

/**
 * An admission that carries `expect`.
 * @param key - The storage key.
 * @param jobId - The job.
 * @param condition - The condition.
 * @returns The admission.
 */
function conditional(key: string, jobId: string, condition: Expect): Admission {
  return { ...admission(key, jobId), expect: condition };
}

/**
 * The ingest snapshot of a view.
 * @param view - The store view.
 * @param key - The storage key.
 * @returns The snapshot with `readmit`.
 */
function snapshot(view: MachineView, key: string): Snapshot {
  return presentationSnapshot(view as unknown as Parameters<typeof presentationSnapshot>[0], key, H);
}

/**
 * Publish a version through one job: admit (optionally with a condition), start, plan the publish-only route and report it verified.
 * @param store - The store.
 * @param key - The storage key.
 * @param jobId - The job.
 * @param versionId - The version.
 * @param condition - The admission condition, if any.
 * @returns The view after the report.
 */
async function publish(store: MachineStore, key: string, jobId: string, versionId: string, condition?: Expect): Promise<MachineView> {
  if (condition === undefined) {
    const identity = await planned(store, key, jobId, 'reuse');
    return store.report(identity, { kind: 'verified', bundle: await bundle(key, versionId) });
  }
  await store.accept(conditional(key, jobId, condition));
  const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId, deadlineAt: D }, Date.now());
  expect(token, `${jobId} was admitted and started`).toEqual(expect.any(String));
  const identity = { storageKey: key, sourceFingerprint: H, jobId, deadlineAt: D, token: token! };
  await store.planPresentation(identity, { route: 'reuse', toolInputId: T, planSha256: PLAN });
  return store.report(identity, { kind: 'verified', bundle: await bundle(key, versionId) });
}

/**
 * Make the read observe Bad: the stored descriptor disappears (or is replaced by foreign bytes).
 * @param store - The store.
 * @param key - The storage key.
 * @param replace - Whether to overwrite it instead of deleting it.
 * @returns The view after the read.
 */
async function bad(store: MachineStore, key: string, replace = false): Promise<MachineView> {
  if (replace) await env.BUCKET.put(videoPresentationKeyFor(key), '{"foreign":true}', { httpMetadata: { contentType: 'application/json' } });
  else await env.BUCKET.delete(videoPresentationKeyFor(key));
  return store.read(key, H);
}

describe('the snapshot readmit fact (§93 D6; design §3.5 web→server row)', () => {
  it('RA01 P invalid(V) with V\'s publisher current and no readmitOf: readmit is true', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      const view = await bad(store, key);
      expect(view.selected).toEqual({ kind: 'invalid', version: { versionId: V, toolInputId: T } });
      expect(snapshot(view, key).readmit).toBe(true);
    });
  });

  it('RA02 P ready: readmit is false', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const view = await publish(store, key, 'job-a', V);
      expect(view.selected.kind).toBe('ready');
      expect(snapshot(view, key).readmit).toBe(false);
    });
  });

  it('RA03 a newer candidate in progress after V failed: readmit is false', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      await bad(store, key);
      const view = await store.accept(admission(key, 'job-b'));
      expect(snapshot(view, key).readmit).toBe(false);
    });
  });
});

describe('conditional admissions re-checked in the DO\'s serial entry (§93 D6; design §3.5, §7.1)', () => {
  it('FA01 expect first with no selected P and no candidate is admitted', async () => {
    const key = await source();
    const view = await withStore(key, (store) => store.accept(conditional(key, 'job-a', 'first')));
    expect(view.candidate).toMatchObject({ jobId: 'job-a', state: 'accepted' });
  });

  it('FA02 expect first while a candidate exists is not admitted: the current view comes back unchanged', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await store.accept(admission(key, 'job-a'));
      const view = await store.accept(conditional(key, 'job-b', 'first'));
      expect(view.candidate.jobId).toBe('job-a');
      expect(view.archive).toEqual([]);
    });
  });

  it('FA03 expect first with a selected P is not admitted', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      const view = await store.accept(conditional(key, 'job-b', 'first'));
      expect(view.candidate.jobId).toBe('job-a');
      expect(view.selected.kind).toBe('ready');
    });
  });

  it('FA04 of two concurrent first admissions only one is admitted', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await Promise.all([store.accept(conditional(key, 'job-a', 'first')), store.accept(conditional(key, 'job-b', 'first'))]);
      const view = await store.read(key, H);
      expect(['job-a', 'job-b']).toContain(view.candidate.jobId);
      expect(view.archive).toEqual([]);
    });
  });

  it('RA04 expect readmit while readmit holds is admitted', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      await bad(store, key);
      const view = await store.accept(conditional(key, 'job-b', 'readmit'));
      expect(view.candidate).toMatchObject({ jobId: 'job-b', state: 'accepted' });
    });
  });

  it.each([['P is ready', false], ['a newer candidate is in progress', true]])('RA05 expect readmit when %s is not admitted', async (_name, newer) => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      if (newer) { await bad(store, key); await store.accept(admission(key, 'job-b')); }
      const view = await store.accept(conditional(key, 'job-c', 'readmit'));
      expect(view.candidate.jobId).toBe(newer ? 'job-b' : 'job-a');
    });
  });

  it('RA06 of two concurrent readmits only one is admitted', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      await bad(store, key);
      await Promise.all([store.accept(conditional(key, 'job-b', 'readmit')), store.accept(conditional(key, 'job-c', 'readmit'))]);
      const view = await store.read(key, H);
      expect(['job-b', 'job-c']).toContain(view.candidate.jobId);
      expect(view.archive.map((job) => job.jobId)).toEqual(['job-a']);
    });
  });

  it('RA07 a readmitted version that fails again is not readmitted: readmit false and preparation.failure presentation_invalid', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      await bad(store, key);
      expect((await publish(store, key, 'job-b', V2, 'readmit')).selected).toEqual({ kind: 'ready', version: { versionId: V2, toolInputId: T } });
      const view = await bad(store, key);
      expect(view.selected).toEqual({ kind: 'invalid', version: { versionId: V2, toolInputId: T } });
      const answer = snapshot(view, key);
      expect(answer.readmit).toBe(false);
      expect(answer.preparation?.failure).toBe('presentation_invalid');
      // The code exists only in the snapshot projection: the candidate itself did not fail.
      expect(view.candidate.failure).toBeNull();
      expect((await store.accept(conditional(key, 'job-c', 'readmit'))).candidate.jobId).toBe('job-b');
    });
  });

  it('FA05 an initialization without expect still archives the current candidate and admits (no condition)', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await store.accept(admission(key, 'job-a'));
      const view = await store.accept(admission(key, 'job-b'));
      expect(view.candidate.jobId).toBe('job-b');
      expect(view.archive.map((job) => job.jobId)).toEqual(['job-a']);
    });
  });
});

// §93 D6 (design §3.5 web→server row, repair dispatch): with P invalid, readmit false and the current candidate the publisher,
// a user repair admits a new presentation job instead of handing the publisher an Rt.
describe('repair of a version that failed again after its readmit (§93 D6; design §3.5)', () => {
  it('RR01 the repair admits a new presentation job and archives the publisher', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publish(store, key, 'job-a', V);
      await bad(store, key);
      await publish(store, key, 'job-b', V2, 'readmit');
      await bad(store, key);
      const view = await store.accept({ ...admission(key, 'job-c'), repair: true });
      expect(view.candidate).toMatchObject({ jobId: 'job-c', state: 'accepted' });
      expect(view.archive.map((job) => job.jobId)).toEqual(['job-a', 'job-b']);
    });
  });
});
