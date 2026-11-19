// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The four presentation routes, the two reuse routes' source, and the candidate failures `reuse_source_invalid`,
 * `grid_mismatch` and `edit_over_cap` (inner#1306 test plan §65.2 V03, V05–V07, V09, V10; frames-split design §3.2
 * item 3, §4.1 帧数 row, §4.2 大小上限 row, §7.1 路线表 and failure codes, §7.1.1, §10.6 失败分类, §10.12
 * video-encode-plan.ts and video-presentation-store.ts rows).
 *
 * Routes and their fixed stages (§7.1): encode `plan→count→encode→stitch→publish`; edit file plus playback
 * `plan→count→edit→edit_stitch→encode→stitch→publish`; reuse the edit file `plan→encode→stitch→publish`; reuse the
 * carrier `plan→publish`. The route is chosen from the new job's identity and the latest published version V's: the
 * carrier only from a ready selected P; the edit file also from an invalid V during the automatic readmit.
 *
 * The store cases run over real DO storage and R2 with the S6c harness; pure cases read exports at call time.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor } from '@breatic/shared';
import * as plan from '@shared/mini-tools/video-encode-plan.js';
import { hashMiniToolValue } from '@shared/mini-tools/canonical-value.js';
import { videoPresentationToolInputId } from '@shared/upload/video-presentation-version.js';
import { classifyVideoSourceLedgerFailure } from '@shared/upload/video-source-ledger.js';
import * as machine from '@ingest/video-presentation-state.js';
import { admission, bundle, H, PLAN, planned, source, T, withStore, type Admission, type MachineStore, type MachineView } from './helpers/machine-store.js';

type Route = 'encode' | 'edit' | 'reuse_edit' | 'reuse';
interface Identity { planSha256: string; producerVersion: string; profileVersion: string; editProfileVersion: string | null }
type ChooseRoute = (input: { plan: Identity; reuseFrom: { identity: Identity; ready: boolean } | null }) => Route;
interface Capability { storageKey: string; sourceFingerprint: string; jobId: string; deadlineAt: number; token: string }
interface Grant { capability: Capability | null; reuseFrom?: { versionId: string; ready: boolean } | null }
interface Granting {
  grantPresentation: (identity: { storageKey: string; sourceFingerprint: string; jobId: string }, now: number) => Promise<Grant>;
  planPresentation: (identity: Capability, plan: { route: string; toolInputId: string; planSha256: string }, facts: Record<string, unknown>) => Promise<{ writer: boolean; view: MachineView }>;
  publishReuse: (identity: Capability) => Promise<boolean>;
}

const V = 'e'.repeat(64);
const PRODUCER = '1'.repeat(64);
const PROFILE = '2'.repeat(64);
const EDIT_PROFILE = '3'.repeat(64);
const WITH_EDIT: Identity = { planSha256: PLAN, producerVersion: PRODUCER, profileVersion: PROFILE, editProfileVersion: EDIT_PROFILE };
const NO_EDIT: Identity = { ...WITH_EDIT, editProfileVersion: null };

/**
 * The route chooser over the two identities (§10.12 video-encode-plan.ts row).
 * @returns It.
 */
function chooseRoute(): ChooseRoute {
  return plan.chooseVideoCarrierRoute as unknown as ChooseRoute;
}

/**
 * One export of the shared encode plan, checked to exist.
 * @param name - The export.
 * @returns It.
 */
function planFn<F>(name: string): F {
  const value = (plan as Record<string, unknown>)[name];
  expect(value, `${name} is exported from @shared/mini-tools/video-encode-plan.js`).toBeTypeOf('function');
  return value as F;
}

/**
 * Publish V through one identity-route job, then make the read observe Bad so P is invalid(V).
 * @param store - The store.
 * @param key - The storage key.
 * @returns The view after the read.
 */
async function publishThenInvalidate(store: MachineStore, key: string): Promise<MachineView> {
  const identity = await planned(store, key, 'job-a', 'identity');
  expect((await store.report(identity, { kind: 'verified', bundle: await bundle(key, V) })).selected.kind).toBe('ready');
  await env.BUCKET.delete(videoPresentationKeyFor(key));
  return store.read(key, H);
}

describe('the four routes and their fixed stages (design §7.1 路线表)', () => {
  it.each([
    ['encode', ['plan', 'count', 'encode', 'stitch', 'publish']],
    ['edit', ['plan', 'count', 'edit', 'edit_stitch', 'encode', 'stitch', 'publish']],
    ['reuse_edit', ['plan', 'encode', 'stitch', 'publish']],
    ['reuse', ['plan', 'publish']],
  ] as const)('%s runs %j', (route, stages) => {
    expect(planFn<(name: Route) => string[]>('videoCarrierRouteStages')(route)).toEqual(stages);
  });
});

describe('choosing the route from the new job and the latest published V (design §7.1, §10.12 chooseVideoCarrierRoute)', () => {
  it('V02 every version equal and P ready: reuse the carrier', () => {
    expect(chooseRoute()({ plan: WITH_EDIT, reuseFrom: { identity: WITH_EDIT, ready: true } })).toBe('reuse');
  });

  it('V03 the playback profile differs: reuse the edit file when V has one, encode everything when it has none', () => {
    expect(chooseRoute()({ plan: { ...WITH_EDIT, profileVersion: 'f'.repeat(64) }, reuseFrom: { identity: WITH_EDIT, ready: true } })).toBe('reuse_edit');
    expect(chooseRoute()({ plan: { ...NO_EDIT, profileVersion: 'f'.repeat(64) }, reuseFrom: { identity: NO_EDIT, ready: true } })).toBe('encode');
  });

  it('V05 the producer differs: reuse the edit file when V has one, encode everything when it has none', () => {
    expect(chooseRoute()({ plan: { ...WITH_EDIT, producerVersion: 'f'.repeat(64) }, reuseFrom: { identity: WITH_EDIT, ready: true } })).toBe('reuse_edit');
    expect(chooseRoute()({ plan: { ...NO_EDIT, producerVersion: 'f'.repeat(64) }, reuseFrom: { identity: NO_EDIT, ready: true } })).toBe('encode');
  });

  it('V01 the edit profile differs: a new edit file is encoded', () => {
    expect(chooseRoute()({ plan: { ...WITH_EDIT, editProfileVersion: 'f'.repeat(64) }, reuseFrom: { identity: WITH_EDIT, ready: true } })).toBe('edit');
  });

  it('another plan, or no published version: edit when the source needs an edit file, otherwise encode', () => {
    expect(chooseRoute()({ plan: { ...WITH_EDIT, planSha256: 'f'.repeat(64) }, reuseFrom: { identity: WITH_EDIT, ready: true } })).toBe('edit');
    expect(chooseRoute()({ plan: WITH_EDIT, reuseFrom: null })).toBe('edit');
    expect(chooseRoute()({ plan: NO_EDIT, reuseFrom: null })).toBe('encode');
  });

  it('V06 V invalid during the automatic readmit: never the carrier, but its edit file is reused', () => {
    expect(chooseRoute()({ plan: WITH_EDIT, reuseFrom: { identity: WITH_EDIT, ready: false } })).toBe('reuse_edit');
    expect(chooseRoute()({ plan: NO_EDIT, reuseFrom: { identity: NO_EDIT, ready: false } })).toBe('encode');
  });
});

describe('V06 the readmit after P turned invalid reuses V\'s edit file with the same toolInputId (design §3.2 item 3, §7.1)', () => {
  it('V06 toolInputId = sha256(canonical(sourceFingerprint, planSha256, editFileSha256)); null without an edit file', async () => {
    const edit = 'f'.repeat(64);
    expect(await videoPresentationToolInputId({ sourceFingerprint: H, planSha256: PLAN, editFileSha256: edit } as never))
      .toBe(await hashMiniToolValue({ sourceFingerprint: H, planSha256: PLAN, editFileSha256: edit }));
    expect(await videoPresentationToolInputId({ sourceFingerprint: H, planSha256: PLAN, editFileSha256: null } as never))
      .toBe(await hashMiniToolValue({ sourceFingerprint: H, planSha256: PLAN, editFileSha256: null }));
  });

  it('V06 the readmitted job is granted with V as its reuse source although P is invalid(V)', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      expect((await publishThenInvalidate(store, key)).selected).toEqual({ kind: 'invalid', version: { versionId: V, toolInputId: T } });
      const readmit: Admission = { ...admission(key, 'job-b'), expect: 'readmit' };
      expect((await store.accept(readmit)).candidate).toMatchObject({ jobId: 'job-b', state: 'accepted' });
      const grant = await (store as unknown as Granting).grantPresentation({ storageKey: key, sourceFingerprint: H, jobId: 'job-b' }, Date.now());
      expect(grant.capability).not.toBeNull();
      expect(grant.reuseFrom).toMatchObject({ versionId: V, ready: false });
    });
  });
});

describe('V07 a reuse route whose reused object cannot be read fails reuse_source_invalid (design §7.1 路线表, §10.6)', () => {
  it('V07 the carrier route: the selected carrier object is gone when the candidate publishes', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const identity = await planned(store, key, 'job-a', 'identity');
      const published = await bundle(key, V);
      await store.report(identity, { kind: 'verified', bundle: published });
      await store.accept({ ...admission(key, 'job-b'), targetPolicyVersion: 2 });
      const granting = store as unknown as Granting;
      const { capability } = await granting.grantPresentation({ storageKey: key, sourceFingerprint: H, jobId: 'job-b' }, Date.now());
      expect(capability).not.toBeNull();
      const { descriptor } = published;
      await granting.planPresentation(capability!, { route: 'reuse', toolInputId: T, planSha256: PLAN }, {
        route: 'reuse', toolInputId: T, planSha256: PLAN, producerVersion: descriptor.producerVersion, profileVersion: descriptor.profileVersion,
        display: descriptor.display, playbackClock: descriptor.playbackClock, work: { kind: 'none' }, copyAudio: null,
      });
      // The identity carrier is the stored source object; it is unreadable from here on.
      await env.BUCKET.delete(key);
      await granting.publishReuse(capability!);
      expect((await store.read(key, H)).candidate).toMatchObject({ jobId: 'job-b', state: 'failed', failure: 'reuse_source_invalid' });
    });
  });

  it('V07 reuse_source_invalid is a temporary failure', () => {
    expect(classifyVideoSourceLedgerFailure('reuse_source_invalid')).toBe('transient');
  });
});

describe('V09 grid_mismatch: a chunk or stitch whose measured frames differ from its grid window (design §4.1 帧数 row, §7.1.1)', () => {
  const check = (): ((window: { start: number; end: number }, measuredFrames: number) => 'grid_mismatch' | null) => planFn('checkGridFrames');

  it('V09 measured frames equal to k1 − k0 pass; one more or one fewer is grid_mismatch', () => {
    expect(check()({ start: 120, end: 240 }, 120)).toBeNull();
    expect(check()({ start: 120, end: 240 }, 121)).toBe('grid_mismatch');
    expect(check()({ start: 120, end: 240 }, 119)).toBe('grid_mismatch');
  });

  it('V09 a grid_mismatch attempt is retried; with no retry left it fails the candidate with grid_mismatch', () => {
    const identity = { kind: 'presentation-chunk' as const, jobId: 'job-a', chunk: 0 };
    const open = machine.advancePresentationChunk(machine.NO_PRESENTATION_CHUNK, { kind: 'Sub', retries: 1 }, identity).next;
    const retried = machine.advancePresentationChunk(open, { kind: 'Fail', attempt: 1, code: 'grid_mismatch', usage: 10 }, identity);
    expect(retried.next).toMatchObject({ state: 'open', attempt: 2, retries: 0 });
    const failed = machine.advancePresentationChunk(retried.next, { kind: 'Fail', attempt: 2, code: 'grid_mismatch', usage: 10 }, identity);
    expect(failed.effects).toEqual([{ kind: 'candidate-failed', code: 'grid_mismatch' }]);
  });

  it('V09 grid_mismatch is a temporary failure', () => {
    expect(classifyVideoSourceLedgerFailure('grid_mismatch')).toBe('transient');
  });
});

describe('V10 edit_over_cap: the edit file over presentation.max_edit_bytes (design §4.2 大小上限 row, §10.6)', () => {
  type SizeFailure = (input: { frameCount: number; width: number; height: number; bytesPerPixel: number; maxEditBytes: number; measuredBytes: number | null }) => 'edit_over_cap' | null;
  const failure = (): SizeFailure => planFn('editFileSizeFailure');
  // 1000 frames × 1920 × 1080 × 0.5 = 1 036 800 000 estimated bytes.
  const facts = { frameCount: 1000, width: 1920, height: 1080, bytesPerPixel: 0.5 };

  it('V10 at plan time the estimate frames × output pixels × bytes_per_pixel decides', () => {
    expect(failure()({ ...facts, maxEditBytes: 1_036_800_000, measuredBytes: null })).toBeNull();
    expect(failure()({ ...facts, maxEditBytes: 1_036_799_999, measuredBytes: null })).toBe('edit_over_cap');
  });

  it('V10 after the write the measured size decides', () => {
    expect(failure()({ ...facts, maxEditBytes: 2_000_000_000, measuredBytes: 2_000_000_001 })).toBe('edit_over_cap');
    expect(failure()({ ...facts, maxEditBytes: 2_000_000_000, measuredBytes: 2_000_000_000 })).toBeNull();
  });

  it('V10 edit_over_cap is a content failure', () => {
    expect(classifyVideoSourceLedgerFailure('edit_over_cap')).toBe('content');
  });
});
