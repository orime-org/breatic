// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ingest `prepare` orchestration over the real store with a fake container port (inner#1306 test plan §66, §65.2;
 * frames-split design §5.1 steps 1, 2, 4 and 5, §5.4 chunking and limit rows, §7.1 route table, §7.1.1).
 *
 * One basic execution: the store grants the job (St); the port probes and plans; the route is chosen from the plan's
 * identity and the latest published version V's; the whole route is estimated against the deadline (`too_long`) and an
 * edit file against its cap (`edit_over_cap`); the plan is recorded; the carrier reuse route publishes here; the counted,
 * edit and playback stages are the worker's. The count makes the grid exact and the windows are planned again on it; the
 * edit stitch's measured edit file gives the toolInputId; on `advance_stage publish` the DO checks the stitch's carrier
 * receipt against R2, computes the versionId and commits. A replay of a started job never probes again.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import * as shared from '@breatic/shared';
import { videoContainerJobId } from '@breatic/shared/mini-tools';
import {
  alphaPackedManifestMatchesVersion, alphaPackedManifestSchema, verifyVideoPresentationPlan, videoPresentationPlanSha256, videoPresentationToolInputId, videoPresentationVersionId,
  videoPresentationVersionSchema,
} from '@breatic/shared';
import * as storeModule from '@ingest/video-presentation-store.js';
import { VideoPresentationStore } from '@ingest/video-presentation-store.js';
import { createPresentationContainerPort } from '@ingest/presentation-container-port.js';
import {
  admission, D, digest, DISPLAY, EDIT_PLAN, ENCODING, H, KEYFRAMES, PLAN, PLAN_CONTENT, PRICING, PRODUCER, PROFILE, PUBLIC_BASE, source, withStore, type Identity, type MachineStore,
} from './helpers/machine-store.js';

const EDIT_PROFILE = '3'.repeat(64);
const FPS = { numerator: 25, denominator: 1 };
const ZERO = { numerator: 0, denominator: 1 };
interface ProbeOptions { width?: number; height?: number; frames?: number; edit?: boolean; seekable?: boolean; versions?: Partial<{ producerVersion: string; profileVersion: string }>; keyframes?: typeof KEYFRAMES }
type ProbeOutcome = Record<string, unknown> & { kind: 'planned' } | { kind: 'failed'; code: string };
interface Port {
  probe: (capability: Identity) => Promise<ProbeOutcome>;
  usage: () => Promise<{ wallMs: number; cpuUsec: number | null } | null>;
}
type Work = { kind: 'none' } | { kind: 'encode'; chunks: { start: number; end: number }[] } | { kind: 'edit'; editChunks: { start: number; end: number }[]; chunks: { start: number; end: number }[] };
interface Answer {
  presentation: Record<string, unknown> | null;
  preparation: { targetPolicyVersion: number; jobId: string; stage: string | null; failure: string | null } | null;
  capability: { token: string; deadlineAt: number } | null;
  plan: { route: string; stages: string[]; toolInputId: string | null; planSha256: string; content: Record<string, unknown>; display: Record<string, unknown>;
    source: Record<string, unknown>; editStorageKey: string | null } | null;
  work: Work;
  units: Record<string, { state: string; attempt: number; attempts: { attempt: number; jobId: string; state: string; usageRecorded: boolean }[]; receipts?: Record<string, unknown>[] }>;
  frozen: { pricing: unknown; actorUserId: string; projectId: string | null; carrier?: unknown; edit?: unknown };
}
type Prepare = (store: MachineStore, identity: { storageKey: string; sourceFingerprint: string; jobId: string }, port: Port, now: number) => Promise<Answer>;
type Report = { kind: 'Sub' } | { kind: 'Done'; attempt: number; usage: number; receipts?: Record<string, unknown>[]; count?: Record<string, unknown> }
  | { kind: 'Fail'; attempt: number; code: string; usage: number | null };

const USAGE = { wallMs: 4200, cpuUsec: 1_000_000 };
const COLOR_INPUTS = { matrix: 'bt709', transfer: 'bt709', primaries: 'bt709', range: 'tv', chromaLocation: 'left' };

/**
 * A planned probe answer (the contract's shape): an opaque 8-bit H.264 at 25 fps, 60 frames from 0, no audio.
 * @param options - What differs.
 * @returns The answer.
 */
function planned(options: ProbeOptions = {}): ProbeOutcome {
  const { width = 95, height = 63, frames = 60, edit = false, seekable = true, keyframes = KEYFRAMES } = options;
  return {
    // The digest is the plan's own: fakePort computes it, as the container does (§3.2 item 2).
    kind: 'planned', planSha256: PLAN,
    plan: { ...PLAN_CONTENT, grid: { fps: FPS, gridStart: ZERO, leadFrames: 0, gridEnd: null, singleFrameDurationMs: 5000 }, toolSource: edit ? 'edit' : 'original', display: { width, height } },
    versions: { producerVersion: PRODUCER, profileVersion: PROFILE, editProfileVersion: edit ? EDIT_PROFILE : null, ...options.versions },
    source: { sourceDecodeKey: 'sdr_8bit', keyframes, hdr: false, alpha: false, editTier: edit ? 'edit_h264_intra_8bit_420' : null, seekable, bitDepth: 8,
      color: COLOR_INPUTS },
    gridInput: { fps: FPS, firstVideoTime: ZERO, firstAudioFrameTime: null, audioEnd: null, quantum: ZERO },
    estimate: { lastVideoTime: { numerator: frames - 1, denominator: 25 }, sourceFrames: frames, frameCount: frames, realFrameCount: frames },
    sourceBytes: 4,
  };
}

/**
 * The orchestration under test, read at call time so a missing export fails each case on its own.
 * @returns It.
 */
function prepareFn(): Prepare {
  const fn = (storeModule as Record<string, unknown>).preparePresentation;
  expect(fn, 'preparePresentation is exported from @ingest/video-presentation-store.js').toBeTypeOf('function');
  return fn as Prepare;
}

/**
 * Check an answer against the shared worker-only schema.
 * @param answer - The answer.
 * @returns It.
 */
function checked(answer: Answer): Answer {
  expect(shared.videoPresentationPrepareAnswerSchema.parse(answer)).toEqual(answer);
  return answer;
}

/**
 * A probe outcome with the digest of its own plan, as the container answers it.
 * @param outcome - The outcome.
 * @returns It, with planSha256 = sha256(canonical(plan)).
 */
async function withDigest(outcome: ProbeOutcome): Promise<ProbeOutcome> {
  return outcome.kind === 'planned' ? { ...outcome, planSha256: await videoPresentationPlanSha256(outcome.plan) } : outcome;
}

/**
 * A fake port: the probe answers `outcome`; usage is measured.
 * @param outcome - The probe outcome.
 * @returns The port and its spies.
 */
function fakePort(outcome: ProbeOutcome): Port & { spies: { probe: ReturnType<typeof vi.fn>; usage: ReturnType<typeof vi.fn> } } {
  const probe = vi.fn(async () => withDigest(outcome));
  const usage = vi.fn(async () => USAGE);
  return { probe, usage, spies: { probe, usage } };
}

/**
 * Admit one job and run the orchestration for it.
 * @param store - The store.
 * @param key - The source key.
 * @param jobId - The job.
 * @param port - The container port.
 * @param deadlineAt - The admission deadline.
 * @param now - The time prepare runs at.
 * @param change - Admission fields that differ.
 * @returns The answer.
 */
async function admitAndPrepare(store: MachineStore, key: string, jobId: string, port: Port, deadlineAt = D, now = Date.now(), change: Record<string, unknown> = {}): Promise<Answer> {
  await store.accept({ ...admission(key, jobId, deadlineAt), ...change });
  return checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId }, port, now));
}

/**
 * The shared output key of one sub-job.
 * @param key - The source key.
 * @param jobId - The sub-job id.
 * @returns The key.
 */
function workKey(key: string, jobId: string): string {
  return shared.videoPresentationWorkKeyFor(key, jobId);
}

/**
 * Report one unit the way the worker does.
 * @param store - The store.
 * @param capability - The job's capability.
 * @param unit - The unit.
 * @param report - The report.
 * @returns Whether it was accepted.
 */
function reportUnit(store: MachineStore, capability: Identity, unit: Record<string, unknown>, report: Report): Promise<boolean> {
  return (store.reportChunk as unknown as (c: Identity, u: Record<string, unknown>, r: Report) => Promise<boolean>)(capability, unit, report);
}

/**
 * Write an object as the ingest Worker does for a job: a multipart upload, so R2 keeps no SHA-256 of its own.
 * @param key - The object key.
 * @param bytes - The bytes.
 * @param contentType - The type.
 * @returns Its measured receipt as the job DO forwards it, and the R2 etag.
 */
async function writeOutput(key: string, bytes: Uint8Array, contentType = 'video/mp4'): Promise<{ receipt: { storageKey: string; sha256: string; sizeBytes: number; contentType: string }; etag: string }> {
  const created = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } });
  const part = await created.uploadPart(1, bytes);
  const object = await created.complete([part]);
  expect((await env.BUCKET.head(key))?.checksums.sha256).toBeUndefined();
  return { receipt: { storageKey: key, sha256: await digest(bytes), sizeBytes: bytes.byteLength, contentType }, etag: object.etag };
}

/**
 * The role-tagged receipt list of a stitch that wrote one native carrier.
 * @param receipt - The carrier's measured receipt.
 * @returns The list.
 */
function native(receipt: Record<string, unknown>): Record<string, unknown>[] {
  return [{ role: 'carrier', packing: 'native', ...receipt }];
}

/**
 * The toolInputId of the fixture plan (§3.2 item 3).
 * @param editFileSha256 - The edit file's digest, or null.
 * @returns It.
 */
function toolInputOf(editFileSha256: string | null = null): Promise<string> {
  return videoPresentationToolInputId({ sourceFingerprint: H, planSha256: editFileSha256 === null ? PLAN : EDIT_PLAN, editFileSha256 });
}

/**
 * The versionId the DO must compute for a carrier (§3.2 item 4).
 * @param policyVersion - The admission's target policy.
 * @param toolInputId - The tool input.
 * @param measured - The carrier's measured bytes.
 * @param measured.sha256 - Its SHA-256.
 * @param measured.sizeBytes - Its size.
 * @param display - The display grid.
 * @param planSha256 - The plan's digest.
 * @returns The versionId.
 */
function expectedVersionId(policyVersion: number, toolInputId: string, measured: { sha256: string; sizeBytes: number }, display: Record<string, unknown> = DISPLAY, planSha256 = PLAN): Promise<string> {
  return videoPresentationVersionId({ sourceFingerprint: H, policyVersion, producerVersion: PRODUCER, profileVersion: PROFILE, planSha256, toolInputId,
    display: display as typeof DISPLAY, playback: { sha256: measured.sha256, size: measured.sizeBytes, contentType: 'video/mp4' } });
}

/**
 * The capability of a prepared job.
 * @param key - The source key.
 * @param answer - Its prepare answer.
 * @param jobId - The job.
 * @param deadlineAt - Its deadline.
 * @returns The capability.
 */
function capabilityOf(key: string, answer: Answer, jobId = 'job-a', deadlineAt = D): Identity {
  return { storageKey: key, sourceFingerprint: H, jobId, deadlineAt, token: answer.capability!.token };
}

/**
 * Run one unit to Done on attempt 1.
 * @param store - The store.
 * @param capability - The job.
 * @param unit - The unit.
 * @param done - What the Done carries.
 * @returns Nothing.
 */
async function finish(store: MachineStore, capability: Identity, unit: Record<string, unknown>, done: Partial<Extract<Report, { kind: 'Done' }>> = {}): Promise<void> {
  expect(await reportUnit(store, capability, unit, { kind: 'Sub' })).toBe(true);
  expect(await reportUnit(store, capability, unit, { kind: 'Done', attempt: 1, usage: 1000, ...done })).toBe(true);
}

/**
 * Run the count (with `count` as its measured facts) and move to the next stage.
 * @param store - The store.
 * @param capability - The job.
 * @param count - The count's facts.
 * @returns Nothing.
 */
async function counted(store: MachineStore, capability: Identity, count: Record<string, unknown> = { lastVideoTime: { numerator: 59, denominator: 25 }, sourceFrames: 60 }): Promise<void> {
  expect(await store.advanceStage(capability, 'count')).toBe(true);
  await finish(store, capability, { kind: 'presentation-count' }, { count });
}

/**
 * Encode every playback chunk of the job's current work and open its stitch.
 * @param store - The store.
 * @param key - The source key.
 * @param capability - The job.
 * @returns Nothing.
 */
async function encodeAndOpenStitch(store: MachineStore, key: string, capability: Identity): Promise<void> {
  expect(await store.advanceStage(capability, 'encode')).toBe(true);
  const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: capability.jobId }, fakePort(planned()), Date.now()));
  for (const [chunk] of (answer.work as Extract<Work, { chunks: unknown }>).chunks.entries()) await finish(store, capability, { kind: 'presentation-chunk', chunk });
  expect(await store.advanceStage(capability, 'stitch')).toBe(true);
  expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Sub' })).toBe(true);
}

/**
 * Stitch a carrier for the job and publish it.
 * @param store - The store.
 * @param key - The source key.
 * @param capability - The job.
 * @param bytes - The carrier bytes.
 * @returns The carrier.
 */
async function stitchAndPublish(store: MachineStore, key: string, capability: Identity, bytes = new Uint8Array([1, 1, 2, 3, 5, 8])): Promise<Awaited<ReturnType<typeof writeOutput>>> {
  const carrier = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: capability.jobId, attempt: 1 })), bytes);
  expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts: native(carrier.receipt) })).toBe(true);
  expect(await store.advanceStage(capability, 'publish')).toBe(true);
  return carrier;
}

/**
 * Publish one version through the whole encode route.
 * @param store - The store.
 * @param key - The source key.
 * @param jobId - The job.
 * @returns The carrier.
 */
async function publishEncoded(store: MachineStore, key: string, jobId = 'job-a'): Promise<Awaited<ReturnType<typeof writeOutput>>> {
  const answer = await admitAndPrepare(store, key, jobId, fakePort(planned()));
  const capability = capabilityOf(key, answer, jobId);
  await counted(store, capability);
  await encodeAndOpenStitch(store, key, capability);
  return stitchAndPublish(store, key, capability);
}

/**
 * Take an edit-route job through the count, its edit chunks and its edit stitch.
 * @param store - The store.
 * @param key - The source key.
 * @param capability - The job.
 * @param answer - Its prepare answer.
 * @param bytes - The edit file's bytes.
 * @returns The edit file's receipt as the edit stitch reported it.
 */
async function editStitched(store: MachineStore, key: string, capability: Identity, answer: Answer, bytes = new Uint8Array([7, 7, 7, 7])): Promise<Record<string, unknown>> {
  await counted(store, capability);
  expect(await store.advanceStage(capability, 'edit')).toBe(true);
  for (const [chunk] of (answer.work as Extract<Work, { kind: 'edit' }>).editChunks.entries()) await finish(store, capability, { kind: 'presentation-edit', chunk });
  expect(await store.advanceStage(capability, 'edit_stitch')).toBe(true);
  const written = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-edit-stitch', jobId: capability.jobId, attempt: 1 })), bytes);
  const receipt = { role: 'edit', ...written.receipt, tier: 'edit_h264_intra_8bit_420' };
  await finish(store, capability, { kind: 'presentation-edit-stitch' }, { receipts: [receipt] });
  return { ...receipt, etag: written.etag };
}

/**
 * Check that windows tile [0, frames) without gaps and stay within the frozen cap.
 * @param chunks - The windows.
 * @param frames - The frame count.
 */
function expectTiles(chunks: { start: number; end: number }[], frames: number): void {
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(frames);
  chunks.forEach((chunk, index) => {
    expect(chunk.end).toBeGreaterThan(chunk.start);
    if (index > 0) expect(chunk.start).toBe(chunks[index - 1]!.end);
  });
  expect(chunks.length).toBeLessThanOrEqual(ENCODING.maxParallelChunks);
}

describe('granting the basic execution (inner#1306 §5.1 step 1, §7.1 St)', () => {
  it('PR01 a job the store does not grant gets no capability, plan or work, and nothing is probed', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(planned());
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'never-admitted' }, port, Date.now()));
      expect(answer).toMatchObject({ capability: null, plan: null, work: { kind: 'none' } });
      expect(port.spies.probe).not.toHaveBeenCalled();
    });
  });

  it('PR02 a job whose deadline has passed is not granted and not probed', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(planned());
      const answer = await admitAndPrepare(store, key, 'late', port, Date.now() - 1);
      expect(answer.capability).toBe(null);
      expect(port.spies.probe).not.toHaveBeenCalled();
    });
  });

  it('PR03 a granted job answers its D from the DO admission and the frozen pricing and attribution', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned()));
      expect(answer.capability).toEqual({ token: expect.any(String), deadlineAt: D });
      // The carrier and edit-file encode parameters frozen at admission (limits crf/preset, encoding carrier cap and edit settings) reach the worker.
      expect(answer.frozen).toEqual({ pricing: PRICING, actorUserId: admission(key, 'job-a').actorUserId, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: ENCODING.carrier.maxShortSide },
        edit: { crf: ENCODING.edit.crf, preset: ENCODING.edit.preset } });
    });
  });
});

describe('the plan and route inside one basic execution (inner#1306 §5.1 step 2, §7.1 route table, §5.4)', () => {
  it('PR04 a source without an edit file: the encode route with its toolInputId, the playback windows and the basic usage', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned()));
      expect(answer.plan).toMatchObject({ route: 'encode', stages: ['plan', 'count', 'encode', 'stitch', 'publish'], toolInputId: await toolInputOf(), planSha256: PLAN });
      expect(answer.work.kind).toBe('encode');
      expectTiles((answer.work as Extract<Work, { kind: 'encode' }>).chunks, 60);
      expect(answer.presentation).toBe(null);
      expect(answer.preparation).toMatchObject({ jobId: 'job-a', stage: 'plan', failure: null });
      expect((await store.read(key, H)).usage['job-a']).toMatchObject({ wallMs: USAGE.wallMs, cpuUsec: USAGE.cpuUsec });
    });
  });

  it('PR04b the production port\'s measured probe usage reaches the answer as the usage fact the worker records', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await withDigest(planned());
      const port = createPresentationContainerPort(async () => answer, admission(key, 'job-a'), 'http://source.local/video');
      const got = await admitAndPrepare(store, key, 'job-a', port) as Answer & { usageFact?: Record<string, unknown> };
      expect(got.usageFact).toMatchObject({ jobId: 'job-a', usage: { wallMs: expect.any(Number), cpuUsec: null }, pricing: PRICING.basic });
    });
  });

  it('PR05 a source that needs an edit file: the edit route, no toolInputId before the edit file is measured, edit and playback windows', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })));
      expect(answer.plan).toMatchObject({ route: 'edit', stages: ['plan', 'count', 'edit', 'edit_stitch', 'encode', 'stitch', 'publish'], toolInputId: null, planSha256: EDIT_PLAN });
      const work = answer.work as Extract<Work, { kind: 'edit' }>;
      expect(work.kind).toBe('edit');
      expectTiles(work.editChunks, 60);
      expectTiles(work.chunks, 60);
    });
  });

  it('PR06 an unseekable original\'s edit file is one window (§5.4 limit row)', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const now = Date.now();
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true, seekable: false, width: 3840, height: 2160, frames: 960 })), now + 600_000, now);
      expect((answer.work as Extract<Work, { kind: 'edit' }>).editChunks).toEqual([{ start: 0, end: 960 }]);
      expect(answer.preparation).toMatchObject({ failure: null });
    });
  });

  it('PR07 heavy work splits into several windows that tile every frame within the frozen cap', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const now = Date.now();
      // 4000 frames of 4K against two minutes: the count fits one share, the playback encode needs two windows.
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ width: 3840, height: 2160, frames: 4000 })), now + 120_000, now);
      const chunks = (answer.work as Extract<Work, { kind: 'encode' }>).chunks;
      expect(chunks.length).toBeGreaterThan(1);
      expectTiles(chunks, 4000);
      expect(answer.preparation).toMatchObject({ failure: null });
    });
  });

  it('PR08 a route that cannot finish before the deadline fails the candidate too_long (§5.4 limit row)', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      // 5000 frames of 4K against a minute of budget cannot fit 8 chunks of half that budget.
      const now = Date.now();
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ width: 3840, height: 2160, frames: 5000 })), now + 60_000, now);
      expect(answer.preparation).toMatchObject({ jobId: 'job-a', failure: 'too_long' });
      expect((await store.read(key, H)).candidate).toMatchObject({ state: 'failed', failure: 'too_long' });
    });
  });

  it('PR09 an edit file whose estimate exceeds max_edit_bytes fails the candidate edit_over_cap at plan time (§4.2 size cap row)', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      // 60 frames × 95 × 63 × 0.5 bytes = 179 550 estimated bytes.
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })), D, Date.now(), { encoding: { ...ENCODING, edit: { ...ENCODING.edit, maxEditBytes: 179_549 } } });
      expect(answer.preparation).toMatchObject({ failure: 'edit_over_cap' });
    });
  });

  it('PR10 a failed probe fails the candidate with its code: no plan', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort({ kind: 'failed', code: 'classification_unknown' }));
      expect(answer).toMatchObject({ plan: null, work: { kind: 'none' }, preparation: { failure: 'classification_unknown' } });
    });
  });
});

describe('every pickup reads the started job without probing again (inner#1306 §90 E2-9)', () => {
  it('PR11 a replay answers the same plan and work, and the unit set the worker reported', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(planned());
      const first = await admitAndPrepare(store, key, 'job-a', port);
      const capability = capabilityOf(key, first);
      expect(await store.advanceStage(capability, 'count')).toBe(true);
      expect(await reportUnit(store, capability, { kind: 'presentation-count' }, { kind: 'Sub' })).toBe(true);
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, port, Date.now()));
      expect(port.spies.probe).toHaveBeenCalledTimes(1);
      expect(again.plan).toEqual(first.plan);
      expect(again.work).toEqual(first.work);
      expect(again.capability).toEqual(first.capability);
      const unit = again.units['video-presentation:job-a:count'];
      expect(unit).toMatchObject({ state: 'open', attempt: 1 });
      expect(unit!.attempts).toEqual([{ attempt: 1, jobId: videoContainerJobId({ kind: 'presentation-count', jobId: 'job-a', attempt: 1 }), state: 'pending', usageRecorded: false }]);
    });
  });
});

describe('the prepare answer carries the plan and the probe facts the worker writes recipes from (inner#1306 §5.1 2a row, §7.17)', () => {
  it('PF01 a granted job\'s answer carries the plan object, its estimated grid, the probe\'s colour, keyframe and alpha facts and the frozen edit encode', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned()));
      expect(answer.plan).toMatchObject({ content: PLAN_CONTENT, display: DISPLAY, editStorageKey: null,
        source: { color: COLOR_INPUTS, keyframes: KEYFRAMES, editTier: null, alpha: false } });
      await expect(verifyVideoPresentationPlan({ plan: answer.plan!.content as typeof PLAN_CONTENT, planSha256: answer.plan!.planSha256 })).resolves.toBeUndefined();
      expect(answer.frozen.edit).toEqual({ crf: ENCODING.edit.crf, preset: ENCODING.edit.preset });
    });
  });

  it('PF02 the edit route answers its tier, and the edit file the playback chunks read once the edit stitch is measured', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })));
      expect(answer.plan).toMatchObject({ content: { ...PLAN_CONTENT, toolSource: 'edit' }, source: { editTier: 'edit_h264_intra_8bit_420' }, editStorageKey: null });
      const edit = await editStitched(store, key, capabilityOf(key, answer), answer);
      const after = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(planned({ edit: true })), Date.now()));
      expect(after.plan?.editStorageKey).toBe(edit.storageKey);
    });
  });

  it('PF03 the exact count is the answer\'s display grid once the count is done', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned()));
      await counted(store, capabilityOf(key, answer), { lastVideoTime: { numerator: 71, denominator: 25 }, sourceFrames: 72 });
      const after = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(planned()), Date.now()));
      expect(after.plan?.display).toEqual({ ...DISPLAY, frameCount: 72, realFrameCount: 72 });
    });
  });
});

describe('the count makes the grid exact (inner#1306 §4.1 frame count row, §5.4 chunking row)', () => {
  it('CG01 a count that decodes more frames than the estimate re-plans the windows on the exact count and publishes that grid', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned()));
      const capability = capabilityOf(key, answer);
      expect(await store.advanceStage(capability, 'encode')).toBe(false);
      await counted(store, capability, { lastVideoTime: { numerator: 71, denominator: 25 }, sourceFrames: 72 });
      const after = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(planned()), Date.now()));
      expectTiles((after.work as Extract<Work, { kind: 'encode' }>).chunks, 72);
      await encodeAndOpenStitch(store, key, capability);
      await stitchAndPublish(store, key, capability);
      expect((await store.read(key, H)).presentation).toMatchObject({ display: { ...DISPLAY, frameCount: 72, realFrameCount: 72 } });
    });
  });
});

describe('publishing after the stitch (inner#1306 §5.1 step 4, §3.2 items 4 and 6)', () => {
  it('PB01 on advance to publish the DO checks the forwarded receipt against R2, computes the versionId and commits the bundle', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const carrier = await publishEncoded(store, key);
      const view = await store.read(key, H);
      expect(view.selected.kind).toBe('ready');
      const toolInputId = await toolInputOf();
      expect(view.presentation).toEqual({
        schemaVersion: 1, sourceFingerprint: H, versionId: await expectedVersionId(1, toolInputId, carrier.receipt), toolInputId, planSha256: PLAN, policyVersion: 1,
        producerVersion: PRODUCER, profileVersion: PROFILE, original: { width: 95, height: 63, duration: 2.4 }, display: DISPLAY, plan: PLAN_CONTENT,
        // The carrier URL is the frozen public base joined to its storage key; the 95x63 picture is padded to even inside it (§4.3).
        playback: { kind: 'native', displayRect: { x: 0, y: 0, width: 95, height: 63 },
          carrier: { storageKey: carrier.receipt.storageKey, url: `${PUBLIC_BASE}/${carrier.receipt.storageKey}`, etag: carrier.etag, size: carrier.receipt.sizeBytes, sha256: carrier.receipt.sha256, contentType: 'video/mp4' } },
        toolSource: { edit: null, keyframes: KEYFRAMES, sourceDecodeKey: 'sdr_8bit' },
      });
    });
  });

  it.each([
    ['size', { sizeBytes: 7 }],
    ['type', { contentType: 'video/webm' }],
    ['hash', { sha256: 'b'.repeat(64) }],
  ])('PB02 a receipt whose %s disagrees with the R2 object is refused and the candidate does not become verified', async (_name, change) => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned()));
      const capability = capabilityOf(key, answer);
      await counted(store, capability);
      await encodeAndOpenStitch(store, key, capability);
      const carrier = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-a', attempt: 1 })), new Uint8Array([1, 2, 3]));
      await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts: native({ ...carrier.receipt, ...change }) });
      await store.advanceStage(capability, 'publish');
      const view = await store.read(key, H);
      expect(view.candidate.state).not.toBe('verified');
      expect(view.selected.kind).not.toBe('ready');
    });
  });
});

describe('P carries its plan, adopted only under its digest (inner#1306 §3.2 item 6)', () => {
  it('PB04 the published bundle carries the probe\'s plan and passes the reader\'s check', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publishEncoded(store, key);
      const version = videoPresentationVersionSchema.parse((await store.read(key, H)).presentation);
      expect(version.plan).toEqual(PLAN_CONTENT);
      await expect(verifyVideoPresentationPlan(version)).resolves.toBeUndefined();
    });
  });

  it('PB05 a bundle whose plan is not the one its digest names is never published', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const port = fakePort(planned());
      port.spies.probe.mockImplementation(async () => ({ ...planned(), planSha256: EDIT_PLAN }));
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      const capability = capabilityOf(key, answer);
      await counted(store, capability);
      await encodeAndOpenStitch(store, key, capability);
      const carrier = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-a', attempt: 1 })), new Uint8Array([1, 2]));
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts: native(carrier.receipt) })).toBe(true);
      await store.advanceStage(capability, 'publish');
      expect((await store.read(key, H)).selected.kind).not.toBe('ready');
      expect(logged).toHaveBeenCalledWith('ingest_video_presentation_plan_mismatch', expect.objectContaining({ jobId: 'job-a' }));
    });
  });
});

describe('the edit file (inner#1306 §4.2, §3.2 item 3, §3.5 edit-file receipt row)', () => {
  it('ED01 the measured edit file gives the toolInputId; playback encodes after it and P carries its receipt', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })));
      const capability = capabilityOf(key, answer);
      const edit = await editStitched(store, key, capability, answer);
      const toolInputId = await toolInputOf(String(edit.sha256));
      expect(checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(planned({ edit: true })), Date.now())).plan?.toolInputId).toBe(toolInputId);
      await encodeAndOpenStitch(store, key, capability);
      const carrier = await stitchAndPublish(store, key, capability);
      const version = videoPresentationVersionSchema.parse((await store.read(key, H)).presentation);
      expect(version.toolInputId).toBe(toolInputId);
      expect(version.versionId).toBe(await expectedVersionId(1, toolInputId, carrier.receipt, DISPLAY, EDIT_PLAN));
      expect(version.toolSource.edit).toEqual({ storageKey: edit.storageKey, url: `${PUBLIC_BASE}/${String(edit.storageKey)}`, etag: edit.etag, size: edit.sizeBytes,
        sha256: edit.sha256, contentType: 'video/mp4', editProfileVersion: EDIT_PROFILE, tier: 'edit_h264_intra_8bit_420' });
    });
  });

  it('ED02 playback does not start before the edit stitch is done', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })));
      const capability = capabilityOf(key, answer);
      await counted(store, capability);
      expect(await store.advanceStage(capability, 'edit')).toBe(true);
      for (const [chunk] of (answer.work as Extract<Work, { kind: 'edit' }>).editChunks.entries()) await finish(store, capability, { kind: 'presentation-edit', chunk });
      expect(await store.advanceStage(capability, 'edit_stitch')).toBe(true);
      expect(await store.advanceStage(capability, 'encode')).toBe(false);
      expect((await store.read(key, H)).candidate.stage).toBe('edit_stitch');
    });
  });

  it('ED03 a written edit file over max_edit_bytes fails the candidate edit_over_cap (§4.2 size cap row)', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })), D, Date.now(), { encoding: { ...ENCODING, edit: { ...ENCODING.edit, maxEditBytes: 179_550 } } });
      await editStitched(store, key, capabilityOf(key, answer), answer, new Uint8Array(179_551));
      expect((await store.read(key, H)).candidate).toMatchObject({ state: 'failed', failure: 'edit_over_cap' });
    });
  });

  it.each([[100_001, false], [100_000, true]] as const)('ED04 edit chunks of %i bytes in all against a 100000-byte cap: the edit stitch is dispatched only within the cap (§4.2 size cap row)', async (total, within) => {
    const key = await source();
    await withStore(key, async (store) => {
      // The plan-time estimate (4000 × 3840 × 2160 × bytesPerPixel ≈ 66 kB) is within the cap; the encoded chunks may not be.
      const now = Date.now();
      const deadlineAt = now + 200_000;
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true, width: 3840, height: 2160, frames: 4000 })), deadlineAt, now,
        { encoding: { ...ENCODING, edit: { ...ENCODING.edit, bytesPerPixel: 0.000002, maxEditBytes: 100_000 } } });
      expect(answer.preparation).toMatchObject({ failure: null });
      const capability = capabilityOf(key, answer, 'job-a', deadlineAt);
      await counted(store, capability, { lastVideoTime: { numerator: 3999, denominator: 25 }, sourceFrames: 4000 });
      expect(await store.advanceStage(capability, 'edit')).toBe(true);
      const chunks = (answer.work as Extract<Work, { kind: 'edit' }>).editChunks;
      expect(chunks.length, 'the edit stage has more than one chunk').toBeGreaterThan(1);
      // The chunks the stitch would download are stored at their done attempts' keys; together they are `total` bytes.
      for (const [chunk] of chunks.entries()) {
        const size = Math.floor(total / chunks.length) + (chunk === 0 ? total % chunks.length : 0);
        await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-edit', jobId: capability.jobId, chunk, attempt: 1 })), new Uint8Array(size));
        await finish(store, capability, { kind: 'presentation-edit', chunk });
      }
      // The worker dispatches a stage's units only after the DO moved the candidate to it.
      expect(await store.advanceStage(capability, 'edit_stitch'), 'the candidate moves to the edit stitch only within the cap').toBe(within);
      expect((await store.read(key, H)).candidate).toMatchObject(within ? { state: 'building', stage: 'edit_stitch' } : { state: 'failed', stage: 'edit', failure: 'edit_over_cap' });
    });
  });
});

describe('the carrier reuse route from the selected bundle\'s identity (inner#1306 §7.1 复用载体, §3.5 P descriptor)', () => {
  it('RU01 same plan, producer and profile as the selected version: reuse, plan→publish, a new versionId over the selected carrier', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publishEncoded(store, key);
      const before = videoPresentationVersionSchema.parse((await store.read(key, H)).presentation);
      const port = fakePort(planned());
      const answer = await admitAndPrepare(store, key, 'job-b', port, D, Date.now(), { targetPolicyVersion: 2 });
      expect(answer.plan).toMatchObject({ route: 'reuse', stages: ['plan', 'publish'], toolInputId: before.toolInputId });
      expect(answer.work).toEqual({ kind: 'none' });
      const carrier = before.playback.carrier;
      expect(answer.presentation).toEqual({ ...before, policyVersion: 2,
        versionId: await expectedVersionId(2, before.toolInputId, { sha256: carrier.sha256, sizeBytes: carrier.size }) });
    });
  });

  it.each([
    ['producer', { producerVersion: 'f'.repeat(64) }],
    ['profile', { profileVersion: 'f'.repeat(64) }],
  ])('RU02 a different %s version is not reused: without an edit file everything is encoded again', async (_name, versions) => {
    const key = await source();
    await withStore(key, async (store) => {
      await publishEncoded(store, key);
      const answer = await admitAndPrepare(store, key, 'job-b', fakePort(planned({ versions })), D, Date.now(), { targetPolicyVersion: 2 });
      expect(answer.plan?.route).toBe('encode');
    });
  });

  it('RU03 the selected version invalid(V): the same plan is not reused', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publishEncoded(store, key);
      await env.BUCKET.delete(shared.videoPresentationKeyFor(key));
      expect((await store.read(key, H)).selected.kind).toBe('invalid');
      const answer = await admitAndPrepare(store, key, 'job-b', fakePort(planned()), D, Date.now(), { targetPolicyVersion: 2 });
      expect(answer.plan?.route).toBe('encode');
    });
  });

  it('RU04 a reuse candidate whose source version turns invalid before it publishes fails reuse_source_invalid and the snapshot readmits', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await publishEncoded(store, key);
      await store.accept({ ...admission(key, 'job-b'), targetPolicyVersion: 2 });
      const port = fakePort(planned());
      // Granted while V is ready (so the route is reuse); V's descriptor disappears before the probe answers.
      port.spies.probe.mockImplementation(async () => {
        await env.BUCKET.delete(shared.videoPresentationKeyFor(key));
        expect((await store.read(key, H)).selected.kind).toBe('invalid');
        return withDigest(planned());
      });
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-b' }, port, Date.now()));
      expect(answer.plan?.route).toBe('reuse');
      const view = await store.read(key, H);
      expect(view.candidate).toMatchObject({ jobId: 'job-b', state: 'failed', failure: 'reuse_source_invalid' });
      const snapshot = storeModule.presentationSnapshot(view as unknown as Parameters<typeof storeModule.presentationSnapshot>[0], key, H);
      expect(snapshot.readmit).toBe(true);
    });
  });
});

describe('the edit-file reuse route (inner#1306 §7.1 复用编辑用文件, §3.2 identity table)', () => {
  /**
   * Publish V through the edit route.
   * @param store - The store.
   * @param key - The source key.
   * @returns V.
   */
  async function publishEdited(store: MachineStore, key: string): Promise<ReturnType<typeof videoPresentationVersionSchema.parse>> {
    const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })));
    const capability = capabilityOf(key, answer);
    await editStitched(store, key, capability, answer);
    await encodeAndOpenStitch(store, key, capability);
    await stitchAndPublish(store, key, capability);
    return videoPresentationVersionSchema.parse((await store.read(key, H)).presentation);
  }

  it('RE01 only the playback profile changed: V\'s edit file is reused, the toolInputId stays and only playback is encoded', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const v = await publishEdited(store, key);
      const answer = await admitAndPrepare(store, key, 'job-b', fakePort(planned({ edit: true, versions: { profileVersion: 'f'.repeat(64) } })));
      expect(answer.plan).toMatchObject({ route: 'reuse_edit', stages: ['plan', 'encode', 'stitch', 'publish'], toolInputId: v.toolInputId, planSha256: EDIT_PLAN });
      // §5.1 2a row: the playback chunks of the reuse route read V's edit file.
      expect(answer.plan?.editStorageKey).toBe(v.toolSource.edit!.storageKey);
      const capability = capabilityOf(key, answer, 'job-b');
      await encodeAndOpenStitch(store, key, capability);
      await stitchAndPublish(store, key, capability, new Uint8Array([4, 4, 4]));
      const published = videoPresentationVersionSchema.parse((await store.read(key, H)).presentation);
      expect(published.versionId).not.toBe(v.versionId);
      expect(published.toolInputId).toBe(v.toolInputId);
      expect(published.toolSource.edit).toEqual(v.toolSource.edit);
    });
  });

  it('RE02 V\'s edit file no longer stored as measured when the candidate publishes: reuse_source_invalid', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const v = await publishEdited(store, key);
      const answer = await admitAndPrepare(store, key, 'job-b', fakePort(planned({ edit: true, versions: { profileVersion: 'f'.repeat(64) } })));
      const capability = capabilityOf(key, answer, 'job-b');
      await encodeAndOpenStitch(store, key, capability);
      await env.BUCKET.delete(v.toolSource.edit!.storageKey);
      const carrier = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-b', attempt: 1 })), new Uint8Array([4, 4, 4]));
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts: native(carrier.receipt) })).toBe(true);
      expect(await store.advanceStage(capability, 'publish')).toBe(false);
      expect((await store.read(key, H)).candidate).toMatchObject({ jobId: 'job-b', state: 'failed', failure: 'reuse_source_invalid' });
    });
  });
});

describe('the candidate writer\'s ordering and attempt rules (inner#1306 §7.1.1 「候选或产物按全部块推进」)', () => {
  it('OR01 advance to stitch is refused while any chunk\'s latest attempt is not done, and accepted once all are', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const now = Date.now();
      const deadlineAt = now + 120_000;
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ width: 3840, height: 2160, frames: 4000 })), deadlineAt, now);
      const chunks = (answer.work as Extract<Work, { kind: 'encode' }>).chunks;
      expect(chunks.length).toBeGreaterThan(1);
      const capability = capabilityOf(key, answer, 'job-a', deadlineAt);
      await counted(store, capability, { lastVideoTime: { numerator: 3999, denominator: 25 }, sourceFrames: 4000 });
      expect(await store.advanceStage(capability, 'encode')).toBe(true);
      const last = chunks.length - 1;
      for (const [index] of chunks.entries()) {
        expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: index }, { kind: 'Sub' })).toBe(true);
        if (index !== last) expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: index }, { kind: 'Done', attempt: 1, usage: 1000 })).toBe(true);
      }
      expect(await store.advanceStage(capability, 'stitch')).toBe(false);
      expect((await store.read(key, H)).candidate.stage).toBe('encode');
      // Its first attempt fails with retries left: the chunk is open on attempt 2, not done.
      expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: last }, { kind: 'Fail', attempt: 1, code: 'tool_failed', usage: 10 })).toBe(true);
      expect(await store.advanceStage(capability, 'stitch')).toBe(false);
      expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: last }, { kind: 'Done', attempt: 2, usage: 1000 })).toBe(true);
      expect(await store.advanceStage(capability, 'stitch')).toBe(true);
      expect((await store.read(key, H)).candidate.stage).toBe('stitch');
    });
  });

  it('OR02 a stitch Done whose receipt names another attempt\'s work key is refused and the unit stays open', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned()));
      const capability = capabilityOf(key, answer);
      await counted(store, capability);
      await encodeAndOpenStitch(store, key, capability);
      const first = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-a', attempt: 1 })), new Uint8Array([9, 8, 7]));
      // Attempt 1 wrote its carrier, then failed; the DO opens attempt 2.
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Fail', attempt: 1, code: 'tool_failed', usage: 10 })).toBe(true);
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 2, usage: 1200, receipts: native(first.receipt) })).toBe(false);
      expect((await store.read(key, H)).chunks['video-presentation:job-a:stitch']!.state).not.toBe('done');
      const second = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-a', attempt: 2 })), new Uint8Array([4, 4, 4]));
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 2, usage: 1200, receipts: native(second.receipt) })).toBe(true);
      expect((await store.read(key, H)).chunks['video-presentation:job-a:stitch']!.state).toBe('done');
    });
  });
});

describe('done receipts stored and answered per unit (§5.1 step 4; §3.5 alpha manifest)', () => {
  // The 95x63 display pads to 96x64 planes with the picture at the origin; the alpha plane follows after the plane gap.
  const GEOMETRY = { packedWidth: 196, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 100, y: 0, width: 95, height: 63 } };
  // A 3840x2160 display's carrier is scaled to the 1080 short side: 1920x1080 planes (§8.2).
  const UHD_GEOMETRY = { packedWidth: 3844, packedHeight: 1080, colorRect: { x: 0, y: 0, width: 1920, height: 1080 }, alphaRect: { x: 1924, y: 0, width: 1920, height: 1080 } };

  /**
   * A granted encode job with every chunk done and its stitch attempt 1 open, its packed carrier written to R2.
   * @param store - The store.
   * @param key - The source key.
   * @param options - What differs in the probe.
   * @returns The capability and the carrier.
   */
  async function packedStitch(store: MachineStore, key: string, options: ProbeOptions = {}): Promise<{ capability: Identity; carrier: Awaited<ReturnType<typeof writeOutput>> }> {
    const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned(options)));
    const capability = capabilityOf(key, answer);
    await counted(store, capability);
    await encodeAndOpenStitch(store, key, capability);
    const carrier = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-a', attempt: 1 })), new Uint8Array([2, 7, 1, 8]));
    return { capability, carrier };
  }

  it('RD01 an alpha-packed stitch Done stores its carrier receipt with the packed geometry, and prepare answers it on the unit', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key);
      const receipts = [{ role: 'carrier', packing: 'alpha-packed', ...carrier.receipt, geometry: GEOMETRY }];
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts })).toBe(true);
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(planned()), Date.now()));
      expect(again.units['video-presentation:job-a:stitch']!.receipts).toEqual(receipts);
      expect(again.units['video-presentation:job-a:chunk:0']!.receipts).toBeUndefined();
    });
  });

  it('RD02 on publish the DO writes the manifest from the measured carrier and the reported geometry, and records it as the manifest role', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key);
      const receipts = [{ role: 'carrier', packing: 'alpha-packed', ...carrier.receipt, geometry: GEOMETRY }];
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts })).toBe(true);
      expect(await store.advanceStage(capability, 'publish')).toBe(true);
      const view = await store.read(key, H);
      expect(view.selected.kind).toBe('ready');
      const version = videoPresentationVersionSchema.parse(view.presentation);
      const packed = { storageKey: carrier.receipt.storageKey, url: `${PUBLIC_BASE}/${carrier.receipt.storageKey}`, etag: carrier.etag, size: carrier.receipt.sizeBytes, sha256: carrier.receipt.sha256, contentType: 'video/mp4' };
      expect(version.playback).toMatchObject({ kind: 'alpha-packed', carrier: packed });
      const manifestReceipt = (version.playback as Extract<typeof version.playback, { kind: 'alpha-packed' }>).manifest;
      expect(manifestReceipt.storageKey).toBe(`${carrier.receipt.storageKey}.manifest.json`);
      const object = await env.BUCKET.get(manifestReceipt.storageKey);
      const bytes = new Uint8Array(await object!.arrayBuffer());
      expect(manifestReceipt).toEqual({ storageKey: manifestReceipt.storageKey, url: `${PUBLIC_BASE}/${manifestReceipt.storageKey}`, etag: object!.etag, size: bytes.byteLength, sha256: await digest(bytes), contentType: 'application/json' });
      // The manifest names no version (§3.5): the carrier reuse route takes it as it is.
      const manifest = alphaPackedManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      expect(manifest).toEqual({ schemaVersion: 1, packed, ...GEOMETRY });
      expect(alphaPackedManifestMatchesVersion(manifest, version)).toBe(true);
      expect(version.versionId).toBe(await expectedVersionId(1, await toolInputOf(), carrier.receipt));
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(planned()), Date.now()));
      expect(again.units['video-presentation:job-a:stitch']!.receipts).toEqual([...receipts, { role: 'manifest', storageKey: manifestReceipt.storageKey, sha256: manifestReceipt.sha256, sizeBytes: manifestReceipt.size, contentType: 'application/json' }]);
    });
  });

  it('RD04 a 3840x2160 transparent source publishes with the manifest of its 1080 carrier planes', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key, { width: 3840, height: 2160 });
      const receipts = [{ role: 'carrier', packing: 'alpha-packed', ...carrier.receipt, geometry: UHD_GEOMETRY }];
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts })).toBe(true);
      expect(await store.advanceStage(capability, 'publish')).toBe(true);
      const view = await store.read(key, H);
      expect(view.selected.kind).toBe('ready');
      const version = videoPresentationVersionSchema.parse(view.presentation);
      expect(version.display).toMatchObject({ width: 3840, height: 2160 });
      const manifestReceipt = (version.playback as Extract<typeof version.playback, { kind: 'alpha-packed' }>).manifest;
      const object = await env.BUCKET.get(manifestReceipt.storageKey);
      const manifest = alphaPackedManifestSchema.parse(JSON.parse(await object!.text()));
      expect(manifest).toMatchObject(UHD_GEOMETRY);
      expect(alphaPackedManifestMatchesVersion(manifest, version)).toBe(true);
    });
  });

  it.each([
    ['display-size planes', { packedWidth: 7684, packedHeight: 2160, colorRect: { x: 0, y: 0, width: 3840, height: 2160 }, alphaRect: { x: 3844, y: 0, width: 3840, height: 2160 } }],
    ['planes without the plane gap', { ...UHD_GEOMETRY, packedWidth: 3840, alphaRect: { x: 1920, y: 0, width: 1920, height: 1080 } }],
  ])('RD05 a 3840x2160 stitch reporting %s does not publish', async (_name, geometry) => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key, { width: 3840, height: 2160 });
      const receipts = [{ role: 'carrier', packing: 'alpha-packed', ...carrier.receipt, geometry }];
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts })).toBe(true);
      await store.advanceStage(capability, 'publish');
      expect((await store.read(key, H)).selected.kind).not.toBe('ready');
    });
  });

  it.each([
    ['an alpha-packed carrier without its geometry', (receipt: Record<string, unknown>) => [{ role: 'carrier', packing: 'alpha-packed', ...receipt }]],
    ['a manifest the worker claims to have written', (receipt: Record<string, unknown>) => [{ role: 'carrier', packing: 'alpha-packed', ...receipt, geometry: GEOMETRY },
      { role: 'manifest', storageKey: `${String(receipt.storageKey)}.manifest.json`, sha256: 'b'.repeat(64), sizeBytes: 9, contentType: 'application/json' }]],
  ])('RD03 a stitch Done with %s is refused: the unit stays open and nothing publishes', async (_name, receiptsOf) => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key);
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts: receiptsOf(carrier.receipt) })).toBe(false);
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(planned()), Date.now()));
      expect(again.units['video-presentation:job-a:stitch']!.state).toBe('open');
      await store.advanceStage(capability, 'publish');
      expect((await store.read(key, H)).selected.kind).not.toBe('ready');
    });
  });
});

/** What a watched store saw: the objects read inside the serial gate, and a hook run on entering it. */
interface Watch { readInside: string[]; beforeGate: (() => Promise<void>) | null }

/**
 * Run work against a real store whose bucket reports every object body read while the serial gate is held.
 * @param key - The storage key naming the object.
 * @param work - The work, given the store and the watch.
 * @returns The work's result.
 */
async function withWatchedStore<R>(key: string, work: (store: MachineStore, watch: Watch) => Promise<R>): Promise<R> {
  const stub = env.PRESENTATION_STATE_TEST.get(env.PRESENTATION_STATE_TEST.idFromName(key));
  const watch: Watch = { readInside: [], beforeGate: null };
  let inside = false;
  const bucket = new Proxy(env.BUCKET, {
    get(target, name) {
      const value = Reflect.get(target, name) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (name === 'get' && inside) watch.readInside.push(String(args[0]));
        return (value as (...given: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return runInDurableObject(stub, async (_instance, state) => {
    const store = new VideoPresentationStore(state.storage, bucket, async (inner) => {
      const hook = watch.beforeGate;
      watch.beforeGate = null;
      if (hook !== null) await hook();
      return state.blockConcurrencyWhile(async () => {
        inside = true;
        try { return await inner(); } finally { inside = false; }
      });
    });
    return work(store as unknown as MachineStore, watch);
  });
}

// ING-4 (frames-split §7.1.1, §5.1 step 4): blockConcurrencyWhile resets the DO after 30 s, so the edit file and the carrier
// (multipart job outputs R2 keeps no SHA-256 for) are hashed before the gate; inside it only their head is checked.
describe('stored objects are hashed outside the serial gate (inner#1306 §5.1 step 4, §4.2)', () => {
  it('HG01 the edit stitch Done and the publish read no object body while the gate is held', async () => {
    const key = await source();
    await withWatchedStore(key, async (store, watch) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })));
      const capability = capabilityOf(key, answer);
      await editStitched(store, key, capability, answer);
      await encodeAndOpenStitch(store, key, capability);
      await stitchAndPublish(store, key, capability);
      expect((await store.read(key, H)).presentation).not.toBe(null);
      expect(watch.readInside).toEqual([]);
    });
  });

  it('HG02 an edit file rewritten between the outside hash and the gate is refused, and the report taken on retry', async () => {
    const key = await source();
    await withWatchedStore(key, async (store, watch) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(planned({ edit: true })));
      const capability = capabilityOf(key, answer);
      await counted(store, capability);
      expect(await store.advanceStage(capability, 'edit')).toBe(true);
      for (const [chunk] of (answer.work as Extract<Work, { kind: 'edit' }>).editChunks.entries()) await finish(store, capability, { kind: 'presentation-edit', chunk });
      expect(await store.advanceStage(capability, 'edit_stitch')).toBe(true);
      const bytes = new Uint8Array([7, 7, 7, 7]);
      const written = await writeOutput(workKey(key, videoContainerJobId({ kind: 'presentation-edit-stitch', jobId: 'job-a', attempt: 1 })), bytes);
      const unit = { kind: 'presentation-edit-stitch' };
      const done: Report = { kind: 'Done', attempt: 1, usage: 1000, receipts: [{ role: 'edit', ...written.receipt, tier: 'edit_h264_intra_8bit_420' }] };
      expect(await reportUnit(store, capability, unit, { kind: 'Sub' })).toBe(true);
      // The same bytes written again: the size and digest still match, only the etag says the object changed.
      watch.beforeGate = async (): Promise<void> => { await env.BUCKET.put(written.receipt.storageKey, bytes, { httpMetadata: { contentType: 'video/mp4' } }); };
      expect(await reportUnit(store, capability, unit, done)).toBe(false);
      expect(await reportUnit(store, capability, unit, done)).toBe(true);
    });
  });
});
