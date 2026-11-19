// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import { alphaPackedManifestMatchesVersion, alphaPackedManifestSchema, videoPresentationVersionId, videoPresentationVersionSchema } from '@breatic/shared';
import * as storeModule from '@ingest/video-presentation-store.js';
import * as containerModule from '@ingest/media-container.js';
import { admission, D, H, PLAN, produceLedger, PUBLIC_BASE, source, T, withStore, type Identity, type MachineStore } from './helpers/machine-store.js';
import { digest, ENCODING, PRICING } from './helpers/source-ledger-fixture.js';

interface ProbeFacts {
  kind: 'planned'; toolInputId: string; planSha256: string;
  // S6e E3 (design §3.2 item 7, inner 960d483f): the full ledger's encode facts replace the separate keyframe flags.
  routeInput: Record<string, unknown>; encoding: { keyframeOrdinals: number[]; codedWidth: number; codedHeight: number; sourceKeyframes: { pts: { numerator: string; denominator: string }; dts: { numerator: string; denominator: string } }[]; firstPacketDts: { numerator: string; denominator: string } };
  display: { width: number; height: number; duration: { numerator: string; denominator: string } };
  playbackClock: { schemaVersion: 1; timescale: number; runs: { start: number; count: number; step: number; duration: number }[] };
  work: { encodedFrames: number; prerollFrames: number; sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number; bitDepth: 8 | 10; hdr: boolean; audioSeconds: number };
}
type ProbeOutcome = ProbeFacts | { kind: 'failed'; code: string };
// S6d D2-1 (§91): the basic carrier answers the role-tagged receipts it wrote; the store measures them in R2 and assembles the bundle.
type CarrierOutcome = { kind: 'written'; receipts: Record<string, unknown>[] } | { kind: 'failed'; code: string };
interface Port {
  probe: (capability: Identity) => Promise<ProbeOutcome>;
  writeLedger: (capability: Identity, toolInputId: string, encoding: ProbeFacts['encoding']) => Promise<void>;
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
  units: Record<string, { state: string; attempt: number; attempts: { attempt: number; jobId: string; state: string; usageRecorded: boolean }[]; receipts?: Record<string, unknown>[] }>;
  frozen: { pricing: unknown; actorUserId: string; projectId: string | null; carrier?: unknown };
}
type Prepare = (store: MachineStore, identity: { storageKey: string; sourceFingerprint: string; jobId: string }, port: Port, now: number) => Promise<Answer>;

const USAGE = { wallMs: 4200, cpuUsec: 1_000_000 };
const WORK = { encodedFrames: 96, prerollFrames: 0, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1920, outputHeight: 1080, bitDepth: 8 as const, hdr: false, audioSeconds: 0 };
// The selected identity is not a probe fact: preparePresentation supplies it from the selected bundle (inner 54ce9ea3).
const PLAN_IDENTITY = { planSha256: PLAN, producerVersion: 2, profileVersion: 1 };
const DISPLAY = { width: 95, height: 63, duration: { numerator: '12', denominator: '5' } };
const CLOCK = { schemaVersion: 1 as const, timescale: 25, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] };
// §93 D6: the source keyframes and first packet dts every encoding now carries (one keyframe at 0, no shift).
const ZERO = { numerator: '0', denominator: '1' };
const KEYFRAME_FACTS = { sourceKeyframes: [{ pts: ZERO, dts: ZERO }], firstPacketDts: ZERO };
const ROUTE = {
  plan: PLAN_IDENTITY, hdr: false, alpha: 'confirmed_opaque',
  identityQualified: false, colorMatrixTagged: true, codec: 'h264', copyPreservesTimeline: false, audioCopyable: true, sourceBytes: 4,
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
/**
 * Where the basic copy writes (§91 D2-2): the key of the first dispatched copy attempt.
 * @param key - The source key.
 * @param jobId - The job.
 * @returns The copy key.
 */
function copyKeyOf(key: string, jobId: string): string {
  return workKey(key, videoContainerJobId({ kind: 'presentation-copy', jobId, attempt: 1 }));
}

function keyframes(frames: number, every: number): boolean[] {
  return Array.from({ length: frames }, (_value, index) => index % every === 0);
}

/**
 * A fake port: the probe answers `outcome`; the writer commits the real ledger through the store; the identity carrier
 * answers the source's receipt and the copy carrier writes its object at the copy key and answers that receipt; usage is
 * measured.
 * @param store - The store the writer commits through.
 * @param key - The source key.
 * @param outcome - The probe outcome.
 * @returns The port and its spies.
 */
function fakePort(store: MachineStore, key: string, outcome: ProbeOutcome): Port & { spies: Record<keyof Port, ReturnType<typeof vi.fn>> } {
  const probe = vi.fn(async () => outcome);
  const writeLedger = vi.fn(async (capability: Identity) => { await produceLedger(store, capability); });
  const carrier = vi.fn(async (capability: Identity, route: 'identity' | 'copy'): Promise<CarrierOutcome> => {
    if (route === 'identity') {
      const head = (await env.BUCKET.head(key))!;
      return { kind: 'written', receipts: [{ role: 'carrier', packing: 'native', storageKey: key, sha256: H, sizeBytes: head.size, contentType: 'video/mp4' }] };
    }
    const written = await writeCarrier(copyKeyOf(key, capability.jobId), new Uint8Array([3, 1, 4, 1, 5]));
    return { kind: 'written', receipts: [{ role: 'carrier', packing: 'native', ...written.receipt }] };
  });
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
  const keyframeOrdinals = frames.flatMap((flag, index) => (flag ? [index] : []));
  return { kind: 'planned', toolInputId: T, planSha256: PLAN, routeInput, encoding: { keyframeOrdinals, codedWidth: work.sourceWidth, codedHeight: work.sourceHeight, ...KEYFRAME_FACTS },
    work: { ...work, encodedFrames: frames.length }, display: DISPLAY, playbackClock: CLOCK };
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
      // §91 D3b-1: the carrier encode parameters frozen at admission (limits crf/preset, encoding carrier cap) reach the worker.
      expect(answer.frozen).toEqual({ pricing: PRICING, actorUserId: admission(key, 'job-a').actorUserId, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: ENCODING.carrier.maxShortSide } });
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
      // The writer writes the full ledger with the probe's encode facts beside the plan (E3, §3.2 item 7).
      expect(port.spies.writeLedger).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-a', token: answer.capability!.token }), T,
        { keyframeOrdinals: [0, 24, 48, 72], codedWidth: WORK.sourceWidth, codedHeight: WORK.sourceHeight, ...KEYFRAME_FACTS });
      expect(port.spies.carrier).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-a' }), 'identity');
      expect(answer.plan).toEqual({ route: 'identity', stages: ['plan', 'publish'], toolInputId: T, planSha256: PLAN });
      expect(answer.work).toEqual({ kind: 'none' });
      // §91 D2-1: identity writes no object; the store measures the source in R2 and assembles the bundle.
      const head = (await env.BUCKET.head(key))!;
      expect(answer.presentation).toMatchObject({ toolInputId: T, versionId: await expectedVersionId(1, { sha256: H, sizeBytes: head.size }),
        playback: { kind: 'native', carrier: { storageKey: key, url: `${PUBLIC_BASE}/${key}`, etag: head.etag, size: head.size, sha256: H, contentType: 'video/mp4' }, displayRect: null } });
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
      // §91 D2-1, D2-2: the copy object at the copy key, measured in R2, is the published carrier.
      const copyKey = copyKeyOf(key, 'job-a');
      const head = (await env.BUCKET.head(copyKey))!;
      const sha256 = await digest(new Uint8Array([3, 1, 4, 1, 5]));
      expect(answer.presentation).toMatchObject({ versionId: await expectedVersionId(1, { sha256, sizeBytes: 5 }),
        playback: { kind: 'native', carrier: { storageKey: copyKey, url: `${PUBLIC_BASE}/${copyKey}`, etag: head.etag, size: 5, sha256, contentType: 'video/mp4' } } });
    });
  });

  it.each([
    ['a copy receipt whose size disagrees with R2', 'copy', (receipt: Record<string, unknown>): Record<string, unknown> => ({ ...receipt, sizeBytes: 6 })],
    ['a copy receipt at another key than the copy key', 'copy', (receipt: Record<string, unknown>): Record<string, unknown> => ({ ...receipt, storageKey: `${String(receipt.storageKey)}.other` })],
    ['an identity receipt naming another object than the source', 'identity', (receipt: Record<string, unknown>): Record<string, unknown> => ({ ...receipt, storageKey: `${String(receipt.storageKey)}.copy` })],
    ['an identity receipt whose hash is not the source fingerprint', 'identity', (receipt: Record<string, unknown>): Record<string, unknown> => ({ ...receipt, sha256: 'b'.repeat(64) })],
    ['a copy receipt whose content type disagrees with R2', 'copy', (receipt: Record<string, unknown>): Record<string, unknown> => ({ ...receipt, contentType: 'video/webm' })],
  ] as const)('PR12 %s publishes nothing (§91 D2-1)', async (_name, route, change) => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(route === 'copy' ? COPY_ROUTE : IDENTITY_ROUTE));
      const real = port.carrier;
      port.carrier = vi.fn(async (capability: Identity, asked: 'identity' | 'copy'): Promise<CarrierOutcome> => {
        const outcome = await real(capability, asked);
        if (outcome.kind === 'written' && route === 'copy' && change(outcome.receipts[0]!).storageKey !== outcome.receipts[0]!.storageKey) {
          await env.BUCKET.put(String(change(outcome.receipts[0]!).storageKey), new Uint8Array([3, 1, 4, 1, 5]), { httpMetadata: { contentType: 'video/mp4' }, sha256: String(outcome.receipts[0]!.sha256) });
        }
        return outcome.kind === 'written' ? { kind: 'written', receipts: [change(outcome.receipts[0]!)] } : outcome;
      });
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      expect(answer.presentation).toBe(null);
      expect((await store.read(key, H)).candidate.state).not.toBe('verified');
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

  // §93 D7-1 (frames-split design §5.4 上限行, §4.1 row 2): the dispatched copy has no video encode: its estimate is the
  // start seconds plus the selected audio's seconds (the probe's `work.audioSeconds`, 0 without audio) ÷ the AAC rate frozen
  // at admission (`encoding.encoder.aacEncodeSecondsPerSecond`); beyond one chunk share it fails too_long. A one-minute
  // budget gives a 30 s share (chunkShare 0.5); the start is 3 s.
  it.each([
    ['fits: 3 + 200 ÷ 10 = 23 s', 10, 200, null],
    ['no audio: 3 s', 10, 0, null],
    ['exceeds: 3 + 600 ÷ 10 = 63 s', 10, 600, 'too_long'],
    ['exceeds at the frozen rate 5: 3 + 200 ÷ 5 = 43 s', 5, 200, 'too_long'],
  ] as const)('DC01 a dispatched copy that %s', async (_name, rate, audioSeconds, failure) => {
    const key = await source();
    await withStore(key, async (store) => {
      const now = Date.now();
      await store.accept({ ...admission(key, 'job-a', now + 60_000), encoding: { ...ENCODING, encoder: { ...ENCODING.encoder, aacEncodeSecondsPerSecond: rate } } });
      // A small source whose audio is not copyable: dispatched so the standard-4 copy_carrier encodes its audio (§4.1 row 2).
      const port = fakePort(store, key, planned({ ...COPY_ROUTE, audioCopyable: false }, keyframes(96, 24), { ...WORK, audioSeconds }));
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, port, now));
      expect(answer.plan?.route).toBe('dispatch_copy');
      expect(answer.preparation).toMatchObject({ jobId: 'job-a', failure });
      expect(answer.work).toEqual(failure === null ? { kind: 'dispatch_copy' } : { kind: 'none' });
      expect((await store.read(key, H)).candidate).toMatchObject(failure === null ? { state: 'building' } : { state: 'failed', failure });
    });
  });

  // §94 D8 (frames-split design §7.17 copy_carrier row): the DO names the dispatched copy's audio from the probe's facts,
  // the one source the worker reads: none when the probe measured no audio, copied when audioCopyable (dispatched only for
  // its size), encoded otherwise. The default budget leaves every case within the copy's share.
  it.each([
    ['copyable audio, dispatched for its size: copy', DISPATCH_ROUTE, 20, 'copy'],
    ['audio that is not copyable: encode', { ...COPY_ROUTE, audioCopyable: false }, 20, 'encode'],
    ['no audio, dispatched for its size: null', DISPATCH_ROUTE, 0, null],
    ['no audio on a route input that names it not copyable: null', { ...COPY_ROUTE, audioCopyable: false }, 0, null],
  ] as const)('DC02 a dispatched copy names its audio from the probe: %s', async (_name, route, audioSeconds, copyAudio) => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(route, keyframes(96, 24), { ...WORK, audioSeconds }));
      const answer = await admitAndPrepare(store, key, 'job-a', port);
      expect(answer.plan?.route).toBe('dispatch_copy');
      expect(answer.work).toEqual({ kind: 'dispatch_copy' });
      expect((answer as Answer & { copyAudio?: unknown }).copyAudio).toBe(copyAudio);
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

type Report = { kind: 'Sub' } | { kind: 'Done'; attempt: number; usage: number; receipts?: Record<string, unknown>[] } | { kind: 'Fail'; attempt: number; code: string; usage: number | null };

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
  // A job writes its outputs as a multipart upload (`writeStreamedObject`), so R2 keeps no SHA-256 of its own for them.
  const created = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: 'video/mp4' } });
  const part = await created.uploadPart(1, bytes);
  const object = await created.complete([part]);
  expect((await env.BUCKET.head(key))?.checksums.sha256).toBeUndefined();
  return { receipt: { storageKey: key, sha256, sizeBytes: bytes.byteLength, contentType: 'video/mp4' }, etag: object.etag };
}

/**
 * The role-tagged receipt list of a job that wrote one native carrier (§90 E4-15).
 * @param receipt - The carrier's measured receipt.
 * @returns The list a stitch or copy Done carries.
 */
function native(receipt: Record<string, unknown>): Record<string, unknown>[] {
  return [{ role: 'carrier', packing: 'native', ...receipt }];
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
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 1, usage: 1200, receipts: native(carrier.receipt) })).toBe(true);
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
      await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 1, usage: 1200, receipts: native({ ...carrier.receipt, ...change }) });
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
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts: native(carrier.receipt) })).toBe(true);
      expect(await store.advanceStage(capability, 'publish')).toBe(true);
      const view = await store.read(key, H) as unknown as { presentation: Record<string, unknown> | null };
      expect(view.presentation).toMatchObject({ versionId: await expectedVersionId(1, carrier.receipt), playback: { carrier: { storageKey: carrier.receipt.storageKey, sha256: carrier.receipt.sha256 } } });
    });
  });
});

describe('a failed ledger write ends the instance in its class (§91 D2-3; design §10.6 失败分类)', () => {
  it.each([
    ['source_ledger_plan_mismatch', 'failed-content'],
    ['source_ledger_failed', 'failed-transient'],
  ] as const)('PR13 a writer whose ledger write rejects with %s leaves the instance %s', async (code, kind) => {
    const key = await source();
    await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(IDENTITY_ROUTE));
      port.writeLedger = vi.fn(async () => { throw Object.assign(new Error('The container could not write the ledger'), { code }); });
      await admitAndPrepare(store, key, 'job-a', port);
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind, code });
    });
  });
});

// S6d D2-2 (§91; design §5.1 step 3, line 304): the basic copy writes its carrier only through the Worker's outbound
// handler for the named key, under a claim the DO grants the copy job before any byte arrives; the Worker measures what
// landed (etag, size, SHA-256, content type) and answers that receipt. Modelled on `writeSourceLedgerPresentation`.
describe('the basic copy carrier write through the edge (§91 D2-2)', () => {
  type CarrierHandler = (request: Request, environment: unknown, ctx: unknown) => Promise<Response>;
  type Claimable = MachineStore & {
    claimPresentationCarrier: (identity: Identity, key: string, declaration: { byteLength: number; contentType: string }) => Promise<unknown>;
    commitPresentationCarrier: (identity: Identity, owner: string, measured: Record<string, unknown>) => Promise<boolean>;
  };
  const BYTES = new Uint8Array([2, 7, 1, 8, 2, 8]);

  /**
   * The edge handler, failing when it is not exported.
   * @returns It.
   */
  function carrierHandler(): CarrierHandler {
    const found = (containerModule as Record<string, unknown>).writePresentationCarrier;
    expect(found, 'writePresentationCarrier is exported from @ingest/media-container.js').toBeTypeOf('function');
    return found as CarrierHandler;
  }

  /**
   * One container PUT through the edge handler, with the store reached directly as the DO stub.
   * @param store - The source's store.
   * @param key - The source key.
   * @param capability - The writing job.
   * @param change - What differs from a correct write of the copy attempt 1 key.
   * @param change.key - Another path key.
   * @param change.query - Query overrides.
   * @param change.contentLength - Another content length.
   * @returns The response.
   */
  function put(store: MachineStore, key: string, capability: Identity, change: { key?: string; query?: Record<string, string>; contentLength?: number } = {}): Promise<Response> {
    const url = new URL(`http://presentation-carrier.local/${change.key ?? copyKeyOf(key, capability.jobId)}`);
    const query = { jobId: capability.jobId, sourceFingerprint: H, deadlineAt: String(capability.deadlineAt), token: capability.token, attempt: '1', byteLength: String(BYTES.length), ...change.query };
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const request = new Request(url, { method: 'PUT', body: BYTES, headers: { 'content-type': 'video/mp4', 'content-length': String(change.contentLength ?? BYTES.length) } });
    const owner = store as Claimable;
    const environment = { BUCKET: env.BUCKET, MEDIA: { idFromName: (name: string) => name, get: () => ({
      claimPresentationCarrier: (...args: Parameters<Claimable['claimPresentationCarrier']>) => owner.claimPresentationCarrier(...args),
      commitPresentationCarrier: (...args: Parameters<Claimable['commitPresentationCarrier']>) => owner.commitPresentationCarrier(...args),
    }) } };
    return carrierHandler()(request, environment, { params: { key } });
  }

  /**
   * Run a basic copy whose carrier step runs `during` with the copy job's capability, in the copy stage.
   * @param during - What the carrier step does; it answers the carrier outcome.
   * @returns The source key and the prepare answer.
   */
  async function copyWith(during: (store: MachineStore, key: string, capability: Identity) => Promise<CarrierOutcome>): Promise<{ key: string; answer: Answer }> {
    const key = await source();
    const answer = await withStore(key, async (store) => {
      const port = fakePort(store, key, planned(COPY_ROUTE));
      port.carrier = vi.fn(async (capability: Identity) => during(store, key, capability));
      return admitAndPrepare(store, key, 'job-a', port);
    });
    return { key, answer };
  }

  it('BC01 the copy job writes its key once: the object lands, the Worker answers its measured receipt and the store publishes it', async () => {
    let receipt: Record<string, unknown> = {};
    const { key, answer } = await copyWith(async (store, source, capability) => {
      const response = await put(store, source, capability);
      expect(response.status).toBe(200);
      receipt = await response.json();
      return { kind: 'written', receipts: [{ role: 'carrier', packing: 'native', ...receipt }] };
    });
    const copyKey = copyKeyOf(key, 'job-a');
    const head = (await env.BUCKET.head(copyKey))!;
    expect(head.httpMetadata?.contentType).toBe('video/mp4');
    expect(receipt).toEqual({ storageKey: copyKey, sha256: await digest(BYTES), sizeBytes: BYTES.length, contentType: 'video/mp4' });
    expect(answer.presentation).toMatchObject({ playback: { carrier: { storageKey: copyKey, etag: head.etag, size: BYTES.length, sha256: await digest(BYTES) } } });
  });

  it.each([
    ['another attempt\'s key', (key: string): string => workKey(key, videoContainerJobId({ kind: 'presentation-copy', jobId: 'job-a', attempt: 2 }))],
    ['another job\'s copy key', (key: string): string => copyKeyOf(key, 'job-b')],
    ['the source key itself', (key: string): string => key],
  ] as const)('BC02 refuses %s with 403 and stores nothing', async (_name, keyOf) => {
    await copyWith(async (store, source, capability) => {
      const target = keyOf(source);
      const before = await env.BUCKET.head(target);
      expect((await put(store, source, capability, { key: target })).status).toBe(403);
      expect((await env.BUCKET.head(target))?.etag ?? null).toBe(before?.etag ?? null);
      return { kind: 'failed', code: 'presentation_failed' };
    });
  });

  it.each([['a wrong token', { token: 'not-the-token' }], ['another job id', { jobId: 'job-b' }]] as const)('BC03 refuses %s with 409 (no claim) and stores nothing', async (_name, query) => {
    await copyWith(async (store, source, capability) => {
      expect((await put(store, source, capability, { query })).status).toBe(409);
      expect(await env.BUCKET.head(copyKeyOf(source, 'job-a'))).toBeNull();
      return { kind: 'failed', code: 'presentation_failed' };
    });
  });

  it.each([
    ['a content length other than the declared length', { contentLength: 5 }],
    ['no declared length', { query: { byteLength: '' } }],
    ['a malformed fingerprint', { query: { sourceFingerprint: 'not-a-hash' } }],
  ] as const)('BC04 refuses %s with 400 and stores nothing', async (_name, change) => {
    await copyWith(async (store, source, capability) => {
      expect((await put(store, source, capability, change)).status).toBe(400);
      expect(await env.BUCKET.head(copyKeyOf(source, 'job-a'))).toBeNull();
      return { kind: 'failed', code: 'presentation_failed' };
    });
  });

  it('BC05 a second write of the same key is refused and leaves the first object as it landed', async () => {
    await copyWith(async (store, source, capability) => {
      const first = await put(store, source, capability);
      expect(first.status).toBe(200);
      const etag = (await env.BUCKET.head(copyKeyOf(source, 'job-a')))!.etag;
      expect((await put(store, source, capability)).status).toBe(409);
      expect((await env.BUCKET.head(copyKeyOf(source, 'job-a')))!.etag).toBe(etag);
      return { kind: 'written', receipts: [{ role: 'carrier', packing: 'native', ...await first.json() }] };
    });
  });

  it('BC07 the DO grants one claim per copy key: a second claim of the same key is refused before any byte is written', async () => {
    await copyWith(async (store, source, capability) => {
      const owner = store as Claimable;
      const declaration = { byteLength: BYTES.length, contentType: 'video/mp4' };
      expect(await owner.claimPresentationCarrier(capability, copyKeyOf(source, 'job-a'), declaration)).toMatchObject({ owner: expect.any(String) });
      expect(await owner.claimPresentationCarrier(capability, copyKeyOf(source, 'job-a'), declaration)).toBeNull();
      return { kind: 'failed', code: 'presentation_failed' };
    });
  });

  it('BC08 an object already at the copy key is never overwritten, even under a granted claim: 409 and the object unchanged', async () => {
    await copyWith(async (store, source, capability) => {
      const target = copyKeyOf(source, 'job-a');
      const existing = await env.BUCKET.put(target, new Uint8Array([9, 9, 9]), { httpMetadata: { contentType: 'video/mp4' } });
      expect((await put(store, source, capability)).status).toBe(409);
      const head = (await env.BUCKET.head(target))!;
      expect({ etag: head.etag, size: head.size }).toEqual({ etag: existing.etag, size: 3 });
      return { kind: 'failed', code: 'presentation_failed' };
    });
  });

  it('BC06 the DO grants no carrier claim outside the copy stage of a copy-route job', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const answer = await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(IDENTITY_ROUTE)));
      const capability = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: D, token: answer.capability!.token };
      expect(await (store as Claimable).claimPresentationCarrier(capability, copyKeyOf(key, 'job-a'), { byteLength: BYTES.length, contentType: 'video/mp4' })).toBeNull();
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

// §93 D6 (design §7.1 路线表, §7.2): the reuse route starts only from a ready selected P; unknown and invalid count as none.
describe('no reuse from an invalid selected version (§93 D6; design §7.1 路线表)', () => {
  it('RU03 the selected version invalid(V): the same plan is not reused', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(IDENTITY_ROUTE)));
      await env.BUCKET.delete(shared.videoPresentationKeyFor(key));
      expect((await store.read(key, H)).selected.kind).toBe('invalid');
      await store.accept({ ...admission(key, 'job-b'), targetPolicyVersion: 2 });
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-b' }, fakePort(store, key, planned(IDENTITY_ROUTE)), Date.now()));
      expect(answer.plan?.route).not.toBe('reuse');
    });
  });
});

// §93 D6-4 (frames-split design §7.1 路线表 复用行, §3.5 web→server row, §10.6; inner 7d0bbf7c): when the selected version stops
// being the same ready version before a reuse-route candidate publishes, the candidate fails with the temporary code
// reuse_source_invalid, and the snapshot's readmit covers it (a reuse candidate from V that failed so, without readmitOf).
describe('a reuse candidate whose source version turns invalid before it publishes (§93 D6-4; design §7.1)', () => {
  it('RU04 the candidate fails with reuse_source_invalid and the snapshot readmits', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await admitAndPrepare(store, key, 'job-a', fakePort(store, key, planned(IDENTITY_ROUTE)));
      await store.accept({ ...admission(key, 'job-b'), targetPolicyVersion: 2 });
      const port = fakePort(store, key, planned(IDENTITY_ROUTE));
      // Granted while V is ready (so the route is reuse); V's descriptor disappears before the probe answers.
      const answered = port.spies.probe.getMockImplementation()!;
      port.spies.probe.mockImplementation(async (...args: unknown[]) => {
        await env.BUCKET.delete(shared.videoPresentationKeyFor(key));
        expect((await store.read(key, H)).selected.kind).toBe('invalid');
        return (answered as (...values: unknown[]) => Promise<ProbeOutcome>)(...args);
      });
      const answer = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-b' }, port, Date.now()));
      expect(answer.plan?.route).toBe('reuse');
      const view = await store.read(key, H);
      expect(view.candidate).toMatchObject({ jobId: 'job-b', state: 'failed', failure: 'reuse_source_invalid' });
      expect(view.selected.kind).toBe('invalid');
      const snapshot = storeModule.presentationSnapshot(view as unknown as Parameters<typeof storeModule.presentationSnapshot>[0], key, H) as { readmit?: unknown };
      expect(snapshot.readmit).toBe(true);
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
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 2, usage: 1200, receipts: native(carrier.receipt) })).toBe(false);
      const unitKey = 'video-presentation:job-a:copy';
      expect((await store.read(key, H)).chunks[unitKey]!.state).not.toBe('done');
      const second = await writeCarrier(workKey(key, videoContainerJobId({ kind: 'presentation-copy', jobId: 'job-a', attempt: 2 })), new Uint8Array([4, 4, 4]));
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 2, usage: 1200, receipts: native(second.receipt) })).toBe(true);
      expect((await store.read(key, H)).chunks[unitKey]!.state).toBe('done');
    });
  });
});

// S6e E4-15 (inner#1306 §90): the DO stores the role-tagged receipts of the attempt that completed a stitch or copy
// unit and the worker-only prepare answer exposes them per unit; the pin sync takes the candidate's carrier and manifest
// keys from there. Producing the manifest in the stitch or copy recipe stays S6d.
describe('E4-15 done receipts stored and answered per unit (§5.1 step 4; §7.15 candidate 行)', () => {
  // §91 D3-3: the stitch reports the packed carrier and its geometry; the DO writes the manifest itself when it assembles the bundle.
  const GEOMETRY = { packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };

  /**
   * A granted encode job with every chunk done and its stitch attempt 1 open, its packed carrier written to R2.
   * @param store - The store.
   * @param key - The source key.
   * @returns The capability and the carrier.
   */
  async function packedStitch(store: MachineStore, key: string): Promise<{ capability: Identity; carrier: Awaited<ReturnType<typeof writeCarrier>> }> {
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
    const carrier = await writeCarrier(workKey(key, videoContainerJobId({ kind: 'presentation-stitch', jobId: 'job-a', attempt: 1 })), new Uint8Array([2, 7, 1, 8]));
    return { capability, carrier };
  }

  it('RD01 an alpha-packed stitch Done stores its carrier receipt with the packed geometry, and prepare answers it on the unit', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key);
      const receipts = [{ role: 'carrier', packing: 'alpha-packed', ...carrier.receipt, geometry: GEOMETRY }];
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts })).toBe(true);
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(store, key, planned(ENCODE_ROUTE)), Date.now()));
      expect(again.units['video-presentation:job-a:stitch']!.receipts).toEqual(receipts);
      expect(again.units['video-presentation:job-a:chunk:0']!.receipts).toBeUndefined();
    });
  });

  it('RD03 on publish the DO writes the manifest from the measured carrier, the reported geometry and the version identity, and records it as the manifest role', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key);
      const receipts = [{ role: 'carrier', packing: 'alpha-packed', ...carrier.receipt, geometry: GEOMETRY }];
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts })).toBe(true);
      expect(await store.advanceStage(capability, 'publish')).toBe(true);
      const view = await store.read(key, H) as unknown as { selected: { kind: string }; presentation: Record<string, unknown> | null };
      expect(view.selected.kind).toBe('ready');
      const version = videoPresentationVersionSchema.parse(view.presentation);
      const packed = { storageKey: carrier.receipt.storageKey, url: `${PUBLIC_BASE}/${carrier.receipt.storageKey}`, etag: carrier.etag, size: carrier.receipt.sizeBytes, sha256: carrier.receipt.sha256, contentType: 'video/mp4' };
      expect(version.playback).toMatchObject({ kind: 'alpha-packed', carrier: packed });
      const manifestReceipt = (version.playback as { manifest: { storageKey: string; url: string; etag: string; size: number; sha256: string; contentType: string } }).manifest;
      // §91 D3b-3: the manifest key is the carrier key with `.manifest.json`, attempt-scoped like the carrier.
      expect(manifestReceipt.storageKey).toBe(`${carrier.receipt.storageKey}.manifest.json`);
      const object = await env.BUCKET.get(manifestReceipt.storageKey);
      expect(object).not.toBeNull();
      const bytes = new Uint8Array(await object!.arrayBuffer());
      expect(manifestReceipt).toEqual({ storageKey: manifestReceipt.storageKey, url: `${PUBLIC_BASE}/${manifestReceipt.storageKey}`, etag: object!.etag, size: bytes.byteLength, sha256: await digest(bytes), contentType: 'application/json' });
      const manifest = alphaPackedManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      expect(manifest).toEqual({ schemaVersion: 1, versionId: version.versionId, toolInputId: T, planSha256: PLAN, policyVersion: 1, packed, ...GEOMETRY });
      expect(alphaPackedManifestMatchesVersion(manifest, version)).toBe(true);
      // The manifest does not enter its own versionId: the version is the one its carrier alone gives.
      expect(version.versionId).toBe(await expectedVersionId(1, carrier.receipt));
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(store, key, planned(ENCODE_ROUTE)), Date.now()));
      expect(again.units['video-presentation:job-a:stitch']!.receipts).toEqual([...receipts, { role: 'manifest', storageKey: manifestReceipt.storageKey, sha256: manifestReceipt.sha256, sizeBytes: manifestReceipt.size, contentType: 'application/json' }]);
    });
  });

  it.each([
    ['an alpha-packed carrier without its geometry', (receipt: Record<string, unknown>) => [{ role: 'carrier', packing: 'alpha-packed', ...receipt }]],
    ['a manifest the worker claims to have written', (receipt: Record<string, unknown>) => [{ role: 'carrier', packing: 'alpha-packed', ...receipt, geometry: GEOMETRY },
      { role: 'manifest', storageKey: `${String(receipt.storageKey)}.manifest.json`, sha256: 'b'.repeat(64), sizeBytes: 9, contentType: 'application/json' }]],
  ])('RD04 a stitch Done with %s is refused: the unit stays open and nothing publishes', async (_name, receiptsOf) => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await packedStitch(store, key);
      expect(await reportUnit(store, capability, { kind: 'presentation-stitch' }, { kind: 'Done', attempt: 1, usage: 3000, receipts: receiptsOf(carrier.receipt) })).toBe(false);
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(store, key, planned(ENCODE_ROUTE)), Date.now()));
      expect(again.units['video-presentation:job-a:stitch']!.state).toBe('open');
      await store.advanceStage(capability, 'publish');
      expect((await store.read(key, H)).selected.kind).not.toBe('ready');
    });
  });

  it('RD02 a copy Done is answered with its one native carrier receipt', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const { capability, carrier } = await copied(store, key);
      expect(await reportUnit(store, capability, { kind: 'presentation-copy' }, { kind: 'Done', attempt: 1, usage: 1200, receipts: native(carrier.receipt) })).toBe(true);
      const again = checked(await prepareFn()(store, { storageKey: key, sourceFingerprint: H, jobId: 'job-a' }, fakePort(store, key, planned(DISPATCH_ROUTE)), Date.now()));
      expect(again.units['video-presentation:job-a:copy']!.receipts).toEqual(native(carrier.receipt));
    });
  });
});

