// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ingest `prepare` orchestration over the real store with a fake container
 * port (inner#1306 test plan §90 E2; frames-split design §5.1 steps 1, 2 and 5,
 * §5.4 上限, §7.1, §7.4; interface choices E2-2, E2-3, E2-6, E2-8).
 *
 * One basic execution: the store grants the job (St); the port probes and plans;
 * the store records the plan (Tp) and decides the ledger writer; the writer
 * writes full and compact; the route is chosen from the probe facts and the
 * frozen encoding and basic disk; identity and in-basic copy publish here;
 * dispatched copy and encode answer their work; an encode needing more chunks
 * than the frozen cap fails the candidate `too_long` without touching L; the
 * basic execution's usage is reported. A replay of a started job answers the
 * same plan and work without probing again. Real FFmpeg is S6d's.
 *
 * inner 54ce9ea3 (§5.1 step 4, §3.5 P descriptor): the probe facts carry the
 * plan-derived display and playback clock, stored in the candidate; after a
 * stitch or dispatched copy the worker forwards the job DO's measured receipt
 * in `report_chunk Done`, and on `advance_stage publish` the DO checks it
 * against its own measurement of the R2 object, computes the versionId and
 * commits. The selected bundle's plan, producer and profile versions decide the
 * reuse route; a reuse publishes a new versionId over the selected carrier.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import * as shared from '@breatic/shared';
import { videoContainerJobId } from '@breatic/shared/mini-tools';
import { videoPresentationVersionId } from '@breatic/shared';
import * as storeModule from '@ingest/video-presentation-store.js';
import { admission, bundle, D, H, PLAN, produceLedger, PUBLIC_BASE, source, T, withStore, type Bundle, type Identity, type MachineStore } from './helpers/machine-store.js';
import { digest, ENCODING, PRICING } from './helpers/source-ledger-fixture.js';

interface ProbeFacts {
  kind: 'planned'; toolInputId: string; planSha256: string;
  routeInput: Record<string, unknown>; keyframes: boolean[];
  display: { width: number; height: number; duration: { numerator: string; denominator: string } };
  playbackClock: { schemaVersion: 1; timescale: number; runs: { start: number; count: number; step: number; duration: number }[] };
  work: { encodedFrames: number; prerollFrames: number; sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number; bitDepth: 8 | 10; hdr: boolean };
}
type ProbeOutcome = ProbeFacts | { kind: 'failed'; code: string };
type CarrierOutcome = { kind: 'verified'; bundle: Bundle } | { kind: 'failed'; code: string };
interface Port {
  probe: (capability: Identity) => Promise<ProbeOutcome>;
  writeLedger: (capability: Identity, toolInputId: string) => Promise<void>;
  carrier: (capability: Identity, route: 'identity' | 'copy') => Promise<CarrierOutcome>;
  usage: () => Promise<{ wallMs: number; cpuUsec: number | null } | null>;
}
interface Answer {
  presentation: Record<string, unknown> | null;
  preparation: { targetPolicyVersion: number; jobId: string; stage: string | null; failure: string | null } | null;
  capability: { token: string; deadlineAt: number } | null;
  plan: { route: string; stages: string[]; toolInputId: string; planSha256: string } | null;
  work: { kind: 'none' } | { kind: 'dispatch_copy' } | { kind: 'encode'; chunks: { start: number; end: number }[] };
  candidateLedger: { state: string; receipt: unknown; failure: string | null } | null;
  units: Record<string, { state: string; attempt: number; attempts: { attempt: number; jobId: string; state: string; usageRecorded: boolean }[] }>;
  frozen: { pricing: unknown; actorUserId: string; projectId: string | null };
}
type Prepare = (store: MachineStore, identity: { storageKey: string; sourceFingerprint: string; jobId: string }, port: Port, now: number) => Promise<Answer>;

const USAGE = { wallMs: 4200, cpuUsec: 1_000_000 };
const WORK = { encodedFrames: 96, prerollFrames: 0, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1920, outputHeight: 1080, bitDepth: 8 as const, hdr: false };
// The selected identity is not a probe fact: preparePresentation supplies it from the selected bundle (inner 54ce9ea3).
const PLAN_IDENTITY = { planSha256: PLAN, producerVersion: 2, profileVersion: 1 };
const DISPLAY = { width: 95, height: 63, duration: { numerator: '12', denominator: '5' } };
const CLOCK = { schemaVersion: 1 as const, timescale: 25, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] };
const ROUTE = {
  plan: PLAN_IDENTITY, hdr: false, alpha: 'confirmed_opaque',
  identityQualified: false, colorMatrixTagged: true, codec: 'h264', copyPreservesTimeline: false, sourceBytes: 4,
};
const IDENTITY_ROUTE = { ...ROUTE, identityQualified: true };
const COPY_ROUTE = { ...ROUTE, copyPreservesTimeline: true, sourceBytes: 1000 };
// Twice this plus the margin is far beyond the 4 GB basic disk whether counted in GB or GiB.
const DISPATCH_ROUTE = { ...ROUTE, copyPreservesTimeline: true, sourceBytes: 3_000_000_000 };
const ENCODE_ROUTE = { ...ROUTE, hdr: true };

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
  const schema = (shared as Record<string, unknown>).videoPresentationPrepareAnswerSchema as { parse: (value: unknown) => unknown } | undefined;
  expect(schema, 'videoPresentationPrepareAnswerSchema is exported from @breatic/shared').toBeDefined();
  expect(schema!.parse(answer)).toEqual(answer);
  return answer;
}

/**
 * Keyframe flags: every `every` frames, the first included.
 * @param frames - Frame count.
 * @param every - Keyframe interval.
 * @returns The flags.
 */
function keyframes(frames: number, every: number): boolean[] {
  return Array.from({ length: frames }, (_value, index) => index % every === 0);
}

/**
 * A fake port: the probe answers `outcome`; the writer commits the real ledger through the store; the carrier
 * answers a verified identity bundle; usage is measured.
 * @param store - The store the writer commits through.
 * @param key - The source key.
 * @param outcome - The probe outcome.
 * @returns The port and its spies.
 */
function fakePort(store: MachineStore, key: string, outcome: ProbeOutcome): Port & { spies: Record<keyof Port, ReturnType<typeof vi.fn>> } {
  const probe = vi.fn(async () => outcome);
  const writeLedger = vi.fn(async (capability: Identity) => { await produceLedger(store, capability); });
  const carrier = vi.fn(async (): Promise<CarrierOutcome> => ({ kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) }));
  const usage = vi.fn(async () => USAGE);
  return { probe, writeLedger, carrier, usage, spies: { probe, writeLedger, carrier, usage } };
}

/**
 * A planned probe outcome.
 * @param routeInput - The route facts.
 * @param frames - Keyframe flags.
 * @param work - The whole job's work.
 * @returns It.
 */
function planned(routeInput: Record<string, unknown>, frames = keyframes(96, 24), work: ProbeFacts['work'] = WORK): ProbeFacts {
  return { kind: 'planned', toolInputId: T, planSha256: PLAN, routeInput, keyframes: frames, work: { ...work, encodedFrames: frames.length }, display: DISPLAY, playbackClock: CLOCK };
}

/**
 * Admit one job and run the orchestration for it.
 * @param store - The store.
 * @param key - The source key.
 * @param jobId - The job.
 * @param port - The container port.
 * @param deadlineAt - The admission deadline.
 * @param now - The time prepare runs at.
 * @returns The answer.
 */
async function admitAndPrepare(store: MachineStore, key: string, jobId: string, port: Port, deadlineAt = D, now = Date.now()): Promise<Answer> {
  await store.accept(admission(key, jobId, deadlineAt));
  return checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId }, port, now));
}

describe('granting the basic execution (inner#1306 §5.1 step 1, §7.1 St)', () => {
  it('PR01 a job the store does not grant gets no capability, plan or work, and nothing is probed', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(IDENTITY_ROUTE));
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'never-admitted' }, port, Date.now()));
      expect(answer).toMatchObject({ capability: null, plan: null, work: { kind: 'none' } });
      expect(port.spies.probe).not.toHaveBeenCalled();
    });
  });

  it('PR02 a job whose deadline has passed is not granted and not probed', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(IDENTITY_ROUTE));
      const answer = await admitAndPrepare(store, key, 'late', port, Date.now() - 1);
      expect(answer.capability).toBe(null);
      expect(port.spies.probe).not.toHaveBeenCalled();
    });
  });

  it('PR03 a granted job answers its D from the DO admission and the frozen pricing and attribution', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(IDENTITY_ROUTE)));
      expect(answer.capability).toEqual({ token: expect.any(String), deadlineAt: D });
      expect(answer.frozen).toEqual({ pricing: PRICING, actorUserId: admission(key, 'job-a').actorUserId, projectId: null });
    });
  });
});

describe('plan, ledger writer and route inside one basic execution (inner#1306 §5.1 step 2, §7.4 Tp)', () => {
  it('PR04 identity: the writer writes the ledger once, the carrier is published here and the basic usage is reported', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(IDENTITY_ROUTE));
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      expect(port.spies.writeLedger).toHaveBeenCalledTimes(1);
      expect(port.spies.writeLedger).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-a', token: answer.capability!.token }), T);
      expect(port.spies.carrier).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-a' }), 'identity');
      expect(answer.plan).toEqual({ route: 'identity', stages: ['plan', 'publish'], toolInputId: T, planSha256: PLAN });
      expect(answer.work).toEqual({ kind: 'none' });
      expect(answer.presentation).toMatchObject({ versionId: 'e'.repeat(64), toolInputId: T });
      expect(answer.candidateLedger).toMatchObject({ state: 'ready' });
      expect((await store.read(key, H)).usage['job-a']).toMatchObject({ wallMs: USAGE.wallMs, cpuUsec: USAGE.cpuUsec });
    });
  });

  it('PR05 copy that fits the basic disk runs here and publishes', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(COPY_ROUTE));
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      expect(port.spies.carrier).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-a' }), 'copy');
      expect(answer.plan).toMatchObject({ route: 'copy', stages: ['plan', 'copy', 'publish'] });
      expect(answer.work).toEqual({ kind: 'none' });
      expect(answer.presentation).not.toBe(null);
    });
  });

  it('PR06 copy that does not fit the basic disk answers dispatched copy and publishes nothing yet', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(DISPATCH_ROUTE));
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      expect(port.spies.carrier).not.toHaveBeenCalled();
      expect(answer.plan).toMatchObject({ route: 'dispatch_copy', stages: ['plan', 'dispatch_copy', 'publish'] });
      expect(answer.work).toEqual({ kind: 'dispatch_copy' });
      expect(answer.presentation).toBe(null);
      expect(answer.preparation).toMatchObject({ jobId: 'job-a', failure: null });
    });
  });

  it('PR07 encode answers chunk windows that tile every frame, break only at keyframes and stay within the frozen cap', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const frames = keyframes(96, 24);
      const port = fakePort(store, key, planned(ENCODE_ROUTE, frames));
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      expect(port.spies.carrier).not.toHaveBeenCalled();
      expect(answer.plan).toMatchObject({ route: 'encode', stages: ['plan', 'encode', 'stitch', 'publish'] });
      expect(answer.work.kind).toBe('encode');
      const chunks = (answer.work as { chunks: { start: number; end: number }[] }).chunks;
      expect(chunks[0]!.start).toBe(0);
      expect(chunks.at(-1)!.end).toBe(frames.length);
      chunks.forEach((chunk, index) => {
        expect(chunk.end).toBeGreaterThan(chunk.start);
        if (index > 0) expect(chunk.start).toBe(chunks[index - 1]!.end);
        if (chunk.end < frames.length) expect(frames[chunk.end]).toBe(true);
      });
      expect(chunks.length).toBeLessThanOrEqual(ENCODING.maxParallelChunks);
      expect(answer.preparation).toMatchObject({ failure: null });
    });
  });

  it('PR08 encode needing more chunks than the frozen cap fails the candidate too_long and leaves L as written', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      // 5000 frames of 4K 10-bit HDR against a minute of budget cannot fit 8 chunks of half that budget.
      const work = { ...WORK, sourceWidth: 3840, sourceHeight: 2160, outputWidth: 1920, outputHeight: 1080, bitDepth: 10 as const, hdr: true };
      const now = Date.now();
      const port = fakePort(store, key, planned(ENCODE_ROUTE, keyframes(5000, 10), work));
      const answer = await admitAndPrepare(store, key, 'job-a', port, now + 60_000, now);
      expect(answer.preparation).toMatchObject({ jobId: 'job-a', failure: 'too_long' });
      expect(answer.work).toEqual({ kind: 'none' });
      const view = await store.read(key, H);
      expect(view.candidate).toMatchObject({ state: 'failed', failure: 'too_long' });
      expect(view.ledgers[T]!.kind).toBe('ready');
    });
  });

  it('PR09 a job that is not the writer of its toolInputId does not write, and answers the ready ledger', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(DISPATCH_ROUTE)));
      const port = fakePort(store, key, planned(DISPATCH_ROUTE));
      const answer = await admitAndPrepare(store, key, 'job-b', port);
      expect(port.spies.writeLedger).not.toHaveBeenCalled();
      expect(answer.candidateLedger).toMatchObject({ state: 'ready', receipt: { toolInputId: T } });
    });
  });

  it('PR10 a failed probe fails the candidate with its code: no plan, no writer, no carrier', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, { kind: 'failed', code: 'classification_unknown' });
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      expect(answer).toMatchObject({ plan: null, work: { kind: 'none' }, preparation: { failure: 'classification_unknown' } });
      expect(port.spies.writeLedger).not.toHaveBeenCalled();
      expect(port.spies.carrier).not.toHaveBeenCalled();
    });
  });
});

describe('every pickup reads the started job without probing again (inner#1306 §90 E2-9)', () => {
  it('PR11 a replay answers the same plan and work, and the unit set the worker reported', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(ENCODE_ROUTE));
      const first = await admitAndPrepare(store, key, 'job-a', port);
      const capability = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: D, token: first.capability!.token };
      expect(await store.advanceStage(capability, 'encode')).toBe(true);
      expect(await store.reportChunk(capability, { kind: 'presentation-chunk', chunk: 0 }, { kind: 'Sub' })).toBe(true);
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, port, Date.now()));
      expect(port.spies.probe).toHaveBeenCalledTimes(1);
      expect(again.plan).toEqual(first.plan);
      expect(again.work).toEqual(first.work);
      expect(again.capability).toEqual(first.capability);
      const unit = again.units[`video-presentation:job-a:chunk:0`];
      expect(unit).toMatchObject({ state: 'open', attempt: 1 });
      expect(unit!.attempts).toEqual([{ attempt: 1, jobId: videoContainerJobId({ kind: 'presentation-chunk', jobId: 'job-a', chunk: 0, attempt: 1 }), state: 'pending', usageRecorded: false }]);
    });
  });
});

type Report = { kind: 'Sub' } | { kind: 'Done'; attempt: number; usage: number; receipt?: Record<string, unknown> } | { kind: 'Fail'; attempt: number; code: string; usage: number | null };

/**
 * The shared output key of one sub-job.
 * @param key - The source key.
 * @param jobId - The sub-job id.
 * @returns The key.
 */
function workKey(key: string, jobId: string): string {
  const keyFor = (shared as Record<string, unknown>).videoPresentationWorkKeyFor as ((storageKey: string, id: string) => string) | undefined;
  expect(keyFor, 'videoPresentationWorkKeyFor is exported from @breatic/shared').toBeTypeOf('function');
  return keyFor!(key, jobId);
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
 * Write a carrier object as the ingest Worker does for a job, with its SHA-256 stored on the object.
 * @param key - The object key.
 * @param bytes - The carrier bytes.
 * @returns Its measured receipt as the job DO forwards it, and the R2 etag.
 */
async function writeCarrier(key: string, bytes: Uint8Array): Promise<{ receipt: { storageKey: string; sha256: string; sizeBytes: number; contentType: string }; etag: string }> {
  const sha256 = await digest(bytes);
  const object = await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' }, sha256 });
  return { receipt: { storageKey: key, sha256, sizeBytes: bytes.byteLength, contentType: 'video/mp4' }, etag: object.etag };
}

/**
 * The versionId the DO must compute for a carrier (§3.2).
 * @param policyVersion - The admission's target policy.
 * @param measured - The carrier's measured bytes.
 * @param measured.sha256 - Its SHA-256.
 * @param measured.sizeBytes - Its size.
 * @returns The versionId.
 */
function expectedVersionId(policyVersion: number, measured: { sha256: string; sizeBytes: number }): Promise<string> {
  return videoPresentationVersionId({ sourceFingerprint: H, policyVersion, ...PLAN_IDENTITY, display: DISPLAY,
    playback: { sha256: measured.sha256, size: measured.sizeBytes, contentType: 'video/mp4' } });
}

/**
 * A granted dispatched-copy job whose copy attempt 1 wrote its carrier.
 * @param store - The store.
 * @param key - The source key.
 * @returns The capability and the carrier.
 */
async function copied(store: MachineStore, key: string): Promise<{ capability: Identity; carrier: Awaited<ReturnType<typeof writeCarrier>> }> {
  const answer = await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(DISPATCH_ROUTE)));
  const capability = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: D, token: answer.capability!.token };
  expect(await store.advanceStage(capability, 'dispatch_copy')).toBe(true);
  expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Sub' })).toBe(true);
  const carrier = await writeCarrier(workKey(key, videoContainerJobId({ kind: 'presentation-copy', jobId: 'job-a', attempt: 1 })), new Uint8Array([9, 8, 7, 6, 5]));
  return { capability, carrier };
}

describe('publishing after a dispatched copy or a stitch (inner 54ce9ea3 §5.1 step 4)', () => {
  it('PB01 on advance to publish the DO checks the forwarded receipt against R2, computes the versionId and commits the bundle', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await copied(store, key);
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 1, usage: 1200, receipt: carrier.receipt })).toBe(true);
      expect(await store.advanceStage(capability, 'publish')).toBe(true);
      const view = await store.read(key, H) as unknown as { selected: { kind: string }; presentation: Record<string, unknown> | null };
      expect(view.selected.kind).toBe('ready');
      expect(view.presentation).toMatchObject({
        versionId: await expectedVersionId(1, carrier.receipt), toolInputId: T, planSha256: PLAN, policyVersion: 1, producerVersion: 2, profileVersion: 1,
        display: DISPLAY, playbackClock: CLOCK,
        // inner 1c3a5892: the carrier URL is the frozen public base joined to its storage key.
        playback: { kind: 'native', carrier: { storageKey: carrier.receipt.storageKey, url: `${PUBLIC_BASE}/${carrier.receipt.storageKey}`, etag: carrier.etag, size: carrier.receipt.sizeBytes, sha256: carrier.receipt.sha256, contentType: 'video/mp4' } },
      });
    });
  });

  it.each([
    ['size', { sizeBytes: 6 }],
    ['type', { contentType: 'video/webm' }],
    ['hash', { sha256: 'b'.repeat(64) }],
  ])('PB02 a receipt whose %s disagrees with the R2 object is refused and the candidate does not become verified', async (_name, change) => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await copied(store, key);
      await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 1, usage: 1200, receipt: { ...carrier.receipt, ...change } });
      await store.advanceStage(capability, 'publish');
      const view = await store.read(key, H);
      expect(view.candidate.state).not.toBe('verified');
      expect(view.selected.kind).not.toBe('ready');
    });
  });

  it('PB03 an encode publishes the stitch carrier once every chunk and the stitch are done', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(ENCODE_ROUTE)));
      const capability = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: D, token: answer.capability!.token };
      const chunks = (answer.work as { chunks: { start: number; end: number }[] }).chunks;
      expect(await store.advanceStage(capability, 'encode')).toBe(true);
      for (const [index] of chunks.entries()) {
        expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: index }, { kind: 'Sub' })).toBe(true);
        expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: index }, { kind: 'Done', attempt: 1, usage: 1000 })).toBe(true);
      }
      expect(await store.advanceStage(capability, 'stitch')).toBe(true);
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Sub' })).toBe(true);
      const carrier = await writeCarrier(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-a', attempt: 1 })), new Uint8Array([1, 1, 2, 3, 5, 8]));
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipt: carrier.receipt })).toBe(true);
      expect(await store.advanceStage(capability, 'publish')).toBe(true);
      const view = await store.read(key, H) as unknown as { presentation: Record<string, unknown> | null };
      expect(view.presentation).toMatchObject({ versionId: await expectedVersionId(1, carrier.receipt), playback: { carrier: { storageKey: carrier.receipt.storageKey, sha256: carrier.receipt.sha256 } } });
    });
  });
});

describe('the reuse route from the selected bundle\'s identity (inner 54ce9ea3 §3.5 P descriptor, §7.1 复用载体)', () => {
  it('RU01 same plan, producer and profile as the selected version: reuse, plan→publish, a new versionId over the selected carrier, no carrier work', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(IDENTITY_ROUTE)));
      const before = (await store.read(key, H) as unknown as { presentation: { playback: { carrier: Record<string, unknown> } } }).presentation;
      await store.accept({ ...admission(key, 'job-b'), targetPolicyVersion: 2 });
      const port = fakePort(store, key, planned(IDENTITY_ROUTE));
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-b' }, port, Date.now()));
      expect(answer.plan).toMatchObject({ route: 'reuse', stages: ['plan', 'publish'] });
      expect(answer.work).toEqual({ kind: 'none' });
      expect(port.spies.carrier).not.toHaveBeenCalled();
      const carrier = before.playback.carrier as { sha256: string; size: number };
      expect(answer.presentation).toMatchObject({ policyVersion: 2, producerVersion: 2, profileVersion: 1, playback: { carrier: before.playback.carrier },
        versionId: await expectedVersionId(2, { sha256: carrier.sha256, sizeBytes: carrier.size }) });
    });
  });

  it.each([
    ['producer', { ...PLAN_IDENTITY, producerVersion: 3 }],
    ['profile', { ...PLAN_IDENTITY, profileVersion: 2 }],
  ])('RU02 a different %s version is not reused', async (_name, plan) => {
    const key = await source();
    await withStore(key, async (store) => {
      await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(IDENTITY_ROUTE)));
      await store.accept({ ...admission(key, 'job-b'), targetPolicyVersion: 2 });
      const port = fakePort(store, key, planned({ ...IDENTITY_ROUTE, plan }));
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-b' }, port, Date.now()));
      expect(answer.plan?.route).not.toBe('reuse');
    });
  });
});

describe('the candidate writer\'s ordering and attempt rules (inner#1306 §7.1.1 「候选或产物按全部块推进」, §5.1 step 2a 「全部块记录后再派stitch」)', () => {
  // 960 frames of 4K 10-bit HDR against a minute of budget: more than one chunk, within the cap of 8.
  const heavy = { ...WORK, sourceWidth: 3840, sourceHeight: 2160, outputWidth: 1920, outputHeight: 1080, bitDepth: 10 as const, hdr: true };

  it('OR01 advance to stitch is refused while any chunk\'s latest attempt is not done, and accepted once all are', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const now = Date.now();
      const deadlineAt = now + 60_000;
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(ENCODE_ROUTE, keyframes(960, 24), heavy)), deadlineAt, now);
      const chunks = (answer.work as { chunks: { start: number; end: number }[] }).chunks;
      expect(chunks.length).toBeGreaterThan(1);
      const capability = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt, token: answer.capability!.token };
      expect(await store.advanceStage(capability, 'encode')).toBe(true);
      const last = chunks.length - 1;
      for (const [index] of chunks.entries()) {
        expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: index }, { kind: 'Sub' })).toBe(true);
        if (index !== last) expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: index }, { kind: 'Done', attempt: 1, usage: 1000 })).toBe(true);
      }
      // The last chunk is open with its first attempt pending.
      expect(await store.advanceStage(capability, 'stitch')).toBe(false);
      expect((await store.read(key, H)).candidate.stage).toBe('encode');
      // Its first attempt fails with retries left: the chunk is open on attempt 2, not done.
      expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: last }, { kind: 'Fail', attempt: 1, code: 'tool_failed', usage: 10 })).toBe(true);
      expect(await store.advanceStage(capability, 'stitch')).toBe(false);
      expect((await store.read(key, H)).candidate.stage).toBe('encode');
      expect(await reportUnit(store, capability, { kind: 'presentation-chunk', chunk: last }, { kind: 'Done', attempt: 2, usage: 1000 })).toBe(true);
      expect(await store.advanceStage(capability, 'stitch')).toBe(true);
      expect((await store.read(key, H)).candidate.stage).toBe('stitch');
    });
  });

  it('OR02 a copy Done whose receipt names another attempt\'s work key is refused and the unit stays open', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await copied(store, key);
      // Attempt 1 wrote its carrier, then failed; the DO opens attempt 2.
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Fail', attempt: 1, code: 'tool_failed', usage: 10 })).toBe(true);
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 2, usage: 1200, receipt: carrier.receipt })).toBe(false);
      const unitKey = 'video-presentation:job-a:copy';
      expect((await store.read(key, H)).chunks[unitKey]!.state).not.toBe('done');
      const second = await writeCarrier(workKey(key, videoContainerJobId({ kind: 'presentation-copy', jobId: 'job-a', attempt: 2 })), new Uint8Array([4, 4, 4]));
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 2, usage: 1200, receipt: second.receipt })).toBe(true);
      expect((await store.read(key, H)).chunks[unitKey]!.state).toBe('done');
    });
  });
});

