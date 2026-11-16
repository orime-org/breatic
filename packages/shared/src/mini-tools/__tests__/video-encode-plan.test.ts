// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6b shared encode planning: route, carrier geometry, work estimate, chunk
 * boundaries, job identities and user-run batching (inner#1306, test plan §88;
 * frames-split design §5.1 steps 2 and 2a, §5.4, §7.1 route table, §4.1, §4.3,
 * §5.3 direct-input conditions, §8.2 carrier short side).
 *
 * Every expected value is written from the approved design: HDR transfers are
 * smpte2084 and arib-std-b67 and always encode; a candidate whose planSha256 and
 * producer/profile equal the selected version reuses its carrier; identity also
 * needs an explicit colour matrix tag, so an untagged source is copied with the
 * codec's metadata filter writing the resolved matrix, or encoded; copy runs in
 * the basic container only when twice the source plus the configured margin fits
 * its disk; an encoded carrier whose short side exceeds 1080 scales to short side
 * 1080 with the long side rounded as FFmpeg `scale=-2`, otherwise odd sides pad to
 * even and record the picture rectangle; a job's seconds are its start seconds
 * plus (encoded + pre-roll frames) × (source pixels over the decode-convert rate
 * for the source bit depth and SDR/HDR + output pixels over the encode rate),
 * with no download term; chunk boundaries are the source keyframes
 * nearest the target, the earlier on a tie; presentation over the parallel cap is
 * `too_long`; job ids follow the §5.4 formats with indices from 0 and attempts
 * from 1; batches respect both caps.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as miniTools from '../index.js';
import { MINI_TOOL_JOB_MAX_OUTPUTS } from '../../upload/mini-tool-job.js';

interface Rational { numerator: string; denominator: string }
type Route = 'reuse' | 'identity' | 'copy' | 'dispatch_copy' | 'encode';
interface RouteInput {
  plan: { planSha256: string; producerVersion: number; profileVersion: number };
  selected: { planSha256: string; producerVersion: number; profileVersion: number } | null;
  hdr: boolean;
  alpha: 'confirmed_alpha' | 'confirmed_opaque';
  identityQualified: boolean;
  colorMatrixTagged: boolean;
  codec: string;
  copyPreservesTimeline: boolean;
  audioCopyable: boolean;
  sourceBytes: number;
  copyDiskMarginBytes: number;
  basicDiskBytes: number;
}
interface Rect { x: number; y: number; width: number; height: number }
interface JobWork { encodedFrames: number; prerollFrames: number; sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number; bitDepth: 8 | 10 | 12; hdr: boolean }
interface ClassRates { startSeconds: number; encodePixelsPerSecond: number; decodeConvertPixelsPerSecond: { sdr_8bit: number; sdr_10bit: number; sdr_12bit: number; hdr_8bit: number; hdr_10bit: number; hdr_12bit: number } }
interface Chunk { start: number; end: number }
type JobSpec =
  | { kind: 'presentation-probe'; jobId: string }
  | { kind: 'presentation-chunk'; jobId: string; chunk: number; attempt: number }
  | { kind: 'presentation-stitch'; jobId: string; attempt: number }
  | { kind: 'presentation-copy'; jobId: string; attempt: number }
  | { kind: 'run-batch'; taskId: string; batch: number; attempt: number }
  | { kind: 'run-chunk'; taskId: string; output: number; chunk: number; attempt: number }
  | { kind: 'run-stitch'; taskId: string; output: number; attempt: number }
  | { kind: 'prep'; taskId: string; input: number; attempt: number }
  | { kind: 'prep-chunk'; taskId: string; input: number; chunk: number; attempt: number }
  | { kind: 'prep-stitch'; taskId: string; input: number; attempt: number };
interface PlanShape {
  originMapping: {
    entries: ({ kind: 'source'; start: number; count: number; step: number } | { kind: 'derived-empty' })[];
    firstSource: { supportStart: Rational; lead: null | { kind: 'derived-lead'; start: Rational } };
    lastSource: { support: 'declared' | 'previous-max' | 'single-frame'; supportEnd: Rational; hold: null | { kind: 'derived-hold'; end: Rational } };
  };
  videoSpans: { sourceStart: Rational; sourceEnd: Rational; presentationStart: Rational; rate: Rational }[] | null;
}
interface EncodeApi {
  isHdrTransfer: (transfer: string | null | undefined) => boolean;
  chooseVideoCarrierRoute: (input: RouteInput) => Route;
  videoCarrierRouteStages: (route: Route) => string[];
  videoCarrierTagFilter: (codec: string) => string | null;
  videoCarrierGeometry: (display: { width: number; height: number }, maxShortSide: number) => { width: number; height: number; displayRect: Rect | null };
  videoPlanIsUnaltered: (plan: PlanShape) => boolean;
  estimateVideoJobSeconds: (work: JobWork, rates: ClassRates) => number;
  planVideoEncodeChunks: (input: { keyframes: readonly boolean[]; frameSeconds: number; targetSeconds: number }) => Chunk[];
  presentationEncodeFailure: (chunkCount: number, maxParallelChunks: number) => 'too_long' | null;
  videoContainerJobId: (spec: JobSpec) => string;
  batchVideoRunOutputs: (works: readonly number[], limits: { maxOutputsPerJob: number; shareSeconds: number; fixedSeconds: number }) => { batches: number[][]; oversized: number[] };
}

const api = miniTools as unknown as Partial<EncodeApi>;

/**
 * Read one export of the S6b contract from the mini-tools entry, failing when it does not exist yet.
 * @param name - The export name.
 * @returns The export.
 * @throws {Error} When the export is missing.
 */
function required<K extends keyof EncodeApi>(name: K): EncodeApi[K] {
  const value = api[name];
  expect(value, `${name} is exported from @breatic/shared/mini-tools`).toBeDefined();
  return value as EncodeApi[K];
}

/**
 * A reduced rational literal.
 * @param numerator - The numerator.
 * @param denominator - The denominator.
 * @returns The rational.
 */
function r(numerator: number, denominator = 1): Rational {
  return { numerator: String(numerator), denominator: String(denominator) };
}

const P = 'd'.repeat(64);
const GiB = 1024 ** 3;

/**
 * An opaque SDR source that qualifies for nothing special, with no selected version.
 * @param overrides - Fields to change.
 * @returns The route input.
 */
function routeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    plan: { planSha256: P, producerVersion: 1, profileVersion: 1 }, selected: null, hdr: false, alpha: 'confirmed_opaque',
    // §93 D6: the selected audio's codec is listed in identity_formats (required route fact since the round-2 audio rule).
    identityQualified: false, colorMatrixTagged: true, codec: 'h264', copyPreservesTimeline: false, audioCopyable: true, sourceBytes: GiB, copyDiskMarginBytes: GiB / 2, basicDiskBytes: 4 * GiB, ...overrides,
  };
}

describe('H §4.3 HDR transfers', () => {
  it.each(['smpte2084', 'arib-std-b67'])('H01 %s is HDR', (transfer) => {
    expect(required('isHdrTransfer')(transfer)).toBe(true);
  });
  it.each(['bt709', 'smpte170m', 'bt2020-10', 'unknown', '', null, undefined])('H02 %s is not HDR', (transfer) => {
    expect(required('isHdrTransfer')(transfer)).toBe(false);
  });
});

describe('RT §7.1 and §5.1 carrier route', () => {
  it('RT01 reuses the selected carrier when planSha256, producer and profile all match, even for an HDR source', () => {
    const route = required('chooseVideoCarrierRoute');
    const same = { planSha256: P, producerVersion: 1, profileVersion: 1 };
    expect(route(routeInput({ selected: same }))).toBe('reuse');
    expect(route(routeInput({ selected: same, hdr: true, identityQualified: true }))).toBe('reuse');
  });

  it.each([
    ['planSha256', { planSha256: 'e'.repeat(64), producerVersion: 1, profileVersion: 1 }],
    ['producer version', { planSha256: P, producerVersion: 2, profileVersion: 1 }],
    ['profile version', { planSha256: P, producerVersion: 1, profileVersion: 2 }],
  ])('RT02 a selected version with another %s is not reused', (_, selected) => {
    expect(required('chooseVideoCarrierRoute')(routeInput({ selected, identityQualified: true }))).toBe('identity');
  });

  it('RT03 an HDR source always encodes, even when qualified for identity and copy', () => {
    expect(required('chooseVideoCarrierRoute')(routeInput({ hdr: true, identityQualified: true, copyPreservesTimeline: true }))).toBe('encode');
  });

  it('RT04 a confirmed transparent source encodes its packed display carrier', () => {
    expect(required('chooseVideoCarrierRoute')(routeInput({ alpha: 'confirmed_alpha', identityQualified: true, copyPreservesTimeline: true }))).toBe('encode');
  });

  it('RT05 a qualified opaque SDR source plays the original as identity', () => {
    expect(required('chooseVideoCarrierRoute')(routeInput({ identityQualified: true, copyPreservesTimeline: true }))).toBe('identity');
  });

  it('RT06 copy runs in basic when 2 × source + margin fits its disk, otherwise it is dispatched', () => {
    const route = required('chooseVideoCarrierRoute');
    // 2 × 1.75 GiB + 0.5 GiB = 4 GiB fits a 4 GiB disk exactly.
    expect(route(routeInput({ copyPreservesTimeline: true, sourceBytes: 1.75 * GiB }))).toBe('copy');
    expect(route(routeInput({ copyPreservesTimeline: true, sourceBytes: 1.75 * GiB + 1 }))).toBe('dispatch_copy');
    expect(route(routeInput({ copyPreservesTimeline: true, sourceBytes: GiB }))).toBe('copy');
  });

  it('RT07 a source whose packets cannot be copied on the same timeline encodes', () => {
    expect(required('chooseVideoCarrierRoute')(routeInput())).toBe('encode');
  });

  it('RT08 HDR or transparent sources never take identity or copy (property)', () => {
    const route = required('chooseVideoCarrierRoute');
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.integer({ min: 1, max: 4 * GiB }), (hdr, qualified, copies, bytes) => {
      const alpha = hdr ? 'confirmed_opaque' as const : 'confirmed_alpha' as const;
      expect(route(routeInput({ hdr, alpha, identityQualified: qualified, copyPreservesTimeline: copies, sourceBytes: bytes }))).toBe('encode');
    }), { seed: 130801, numRuns: 100 });
  });

  it('RT10 an untagged source never plays the original: it is copied with its matrix tag written, or dispatched, or encoded', () => {
    const route = required('chooseVideoCarrierRoute');
    expect(route(routeInput({ colorMatrixTagged: false, identityQualified: true, copyPreservesTimeline: true }))).toBe('copy');
    expect(route(routeInput({ colorMatrixTagged: false, identityQualified: true, copyPreservesTimeline: true, sourceBytes: 1.75 * GiB + 1 }))).toBe('dispatch_copy');
    expect(route(routeInput({ colorMatrixTagged: false, identityQualified: true }))).toBe('encode');
    for (const codec of ['hevc', 'vp9', 'av1']) expect(route(routeInput({ colorMatrixTagged: false, identityQualified: true, copyPreservesTimeline: true, codec }))).toBe('copy');
  });

  it('RT11 an untagged source whose codec has no metadata filter cannot gain its tag by copy and encodes', () => {
    expect(required('chooseVideoCarrierRoute')(routeInput({ colorMatrixTagged: false, identityQualified: true, copyPreservesTimeline: true, codec: 'vp8' }))).toBe('encode');
  });

  it('RT12 an untagged source never takes identity (property)', () => {
    const route = required('chooseVideoCarrierRoute');
    fc.assert(fc.property(fc.boolean(), fc.constantFrom('h264', 'hevc', 'vp9', 'av1', 'vp8', 'mpeg4'), fc.integer({ min: 1, max: 4 * GiB }), (copies, codec, bytes) => {
      expect(route(routeInput({ colorMatrixTagged: false, identityQualified: true, copyPreservesTimeline: copies, codec, sourceBytes: bytes }))).not.toBe('identity');
    }), { seed: 130809, numRuns: 100 });
  });

  it.each([['h264', 'h264_metadata'], ['hevc', 'hevc_metadata'], ['vp9', 'vp9_metadata'], ['av1', 'av1_metadata'], ['vp8', null], ['mpeg4', null], ['prores', null]] as const)('RT13 a %s stream copy writes its matrix tag with %s', (codec, filter) => {
    expect(required('videoCarrierTagFilter')(codec)).toBe(filter);
  });

  it.each([
    ['identity', ['plan', 'publish']], ['copy', ['plan', 'copy', 'publish']], ['dispatch_copy', ['plan', 'dispatch_copy', 'publish']],
    ['encode', ['plan', 'encode', 'stitch', 'publish']], ['reuse', ['plan', 'publish']],
  ] as const)('RT09 the %s route has the fixed stage sequence %o', (route, stages) => {
    expect(required('videoCarrierRouteStages')(route)).toEqual(stages);
  });
});

describe('CG §8.2 and §4.3 encoded carrier geometry', () => {
  it.each([
    [{ width: 3840, height: 2160 }, { width: 1920, height: 1080, displayRect: null }],
    [{ width: 2160, height: 3840 }, { width: 1080, height: 1920, displayRect: null }],
    [{ width: 4096, height: 2160 }, { width: 2048, height: 1080, displayRect: null }],
    [{ width: 3840, height: 1600 }, { width: 2592, height: 1080, displayRect: null }],
    // FFmpeg 7.1.1 `scale=-2:1080` / `scale=1080:-2` readings (test plan §88): the long side is the nearest even value.
    [{ width: 5000, height: 1081 }, { width: 4996, height: 1080, displayRect: null }],
    [{ width: 1081, height: 5000 }, { width: 1080, height: 4996, displayRect: null }],
    [{ width: 3001, height: 1081 }, { width: 2998, height: 1080, displayRect: null }],
    [{ width: 3841, height: 2161 }, { width: 1920, height: 1080, displayRect: null }],
    [{ width: 4000, height: 2251 }, { width: 1920, height: 1080, displayRect: null }],
    [{ width: 1920, height: 1080 }, { width: 1920, height: 1080, displayRect: null }],
    [{ width: 1280, height: 720 }, { width: 1280, height: 720, displayRect: null }],
    [{ width: 161, height: 97 }, { width: 162, height: 98, displayRect: { x: 0, y: 0, width: 161, height: 97 } }],
    [{ width: 1, height: 1 }, { width: 2, height: 2, displayRect: { x: 0, y: 0, width: 1, height: 1 } }],
    [{ width: 1, height: 97 }, { width: 2, height: 98, displayRect: { x: 0, y: 0, width: 1, height: 97 } }],
  ])('CG01 %o encodes as %o', (display, expected) => {
    expect(required('videoCarrierGeometry')(display, 1080)).toEqual(expected);
  });

  it('CG02 any display keeps even sides, a short side of at most 1080, and pads odd sides by one only below the cap (property)', () => {
    const geometry = required('videoCarrierGeometry');
    fc.assert(fc.property(fc.integer({ min: 1, max: 1080 }), fc.integer({ min: 1, max: 8192 }), fc.boolean(), (short, long, portrait) => {
      const display = portrait ? { width: short, height: Math.max(short, long) } : { width: Math.max(short, long), height: short };
      const carrier = geometry(display, 1080);
      expect(carrier.width % 2).toBe(0);
      expect(carrier.height % 2).toBe(0);
      expect(carrier.width - display.width).toBeGreaterThanOrEqual(0);
      expect(carrier.width - display.width).toBeLessThanOrEqual(1);
      expect(carrier.height - display.height).toBeLessThanOrEqual(1);
      const padded = display.width % 2 === 1 || display.height % 2 === 1;
      expect(carrier.displayRect).toEqual(padded ? { x: 0, y: 0, width: display.width, height: display.height } : null);
    }), { seed: 130802, numRuns: 300 });
  });

  it.each([
    ['zero width', { width: 0, height: 1 }, 1080], ['zero height', { width: 1, height: 0 }, 1080],
    ['fractional width', { width: 1.5, height: 2 }, 1080], ['zero cap', { width: 2, height: 2 }, 0],
  ])('CG03 rejects %s', (_, display, cap) => {
    const geometry = required('videoCarrierGeometry');
    expect(() => geometry(display, cap)).toThrow(RangeError);
  });
});

/**
 * An unaltered plan: one source run, no spans, no derived frames, declared support.
 * @returns A fresh plan.
 */
function unaltered(): PlanShape {
  return {
    originMapping: {
      entries: [{ kind: 'source', start: 0, count: 17, step: 2048 }],
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(17, 8), hold: null },
    },
    videoSpans: null,
  };
}

describe('UA §5.3 unaltered origin mapping (direct original input and identity)', () => {
  it('UA01 a plan without edit spans, rate changes, derived frames or derived support is unaltered', () => {
    expect(required('videoPlanIsUnaltered')(unaltered())).toBe(true);
  });

  it.each([
    ['a derived-empty frame', (plan: PlanShape): void => { plan.originMapping.entries = [{ kind: 'source', start: 0, count: 8, step: 2048 }, { kind: 'derived-empty' }, { kind: 'source', start: 20480, count: 8, step: 2048 }]; }],
    ['a derived lead', (plan: PlanShape): void => { plan.originMapping.firstSource = { supportStart: r(1, 16), lead: { kind: 'derived-lead', start: r(0) } }; }],
    ['a derived hold', (plan: PlanShape): void => { plan.originMapping.lastSource = { support: 'declared', supportEnd: r(2), hold: { kind: 'derived-hold', end: r(17, 8) } }; }],
    ['a previous-max last frame', (plan: PlanShape): void => { plan.originMapping.lastSource.support = 'previous-max'; }],
    ['a single-frame support', (plan: PlanShape): void => { plan.originMapping.lastSource.support = 'single-frame'; }],
    ['a rate change', (plan: PlanShape): void => { plan.videoSpans = [{ sourceStart: r(0), sourceEnd: r(17, 16), presentationStart: r(0), rate: r(1, 2) }]; }],
    ['a cut between two edits', (plan: PlanShape): void => { plan.videoSpans = [{ sourceStart: r(0), sourceEnd: r(1), presentationStart: r(0), rate: r(1) }, { sourceStart: r(3, 2), sourceEnd: r(21, 8), presentationStart: r(1), rate: r(1) }]; }],
    // The assembler stores a whole-media rate-1 edit as no edit, so any recorded span is an edit.
    ['one recorded rate-1 span', (plan: PlanShape): void => { plan.videoSpans = [{ sourceStart: r(0), sourceEnd: r(17, 8), presentationStart: r(0), rate: r(1) }]; }],
  ])('UA02 a plan with %s is altered', (_, change) => {
    const plan = unaltered();
    change(plan);
    expect(required('videoPlanIsUnaltered')(plan)).toBe(false);
  });
});

// Test rates chosen so each term is whole seconds: one 1080p output frame encodes in 1 s; one 4K source frame
// decodes and converts in 1 s (8-bit SDR), 2 s (10-bit SDR), 3 s (8-bit HDR) or 4 s (10-bit HDR).
const RATES: ClassRates = { startSeconds: 3, encodePixelsPerSecond: 2_073_600, decodeConvertPixelsPerSecond: { sdr_8bit: 8_294_400, sdr_10bit: 4_147_200, sdr_12bit: 1_658_880, hdr_8bit: 2_764_800, hdr_10bit: 2_073_600, hdr_12bit: 1_382_400 } };

/**
 * A job's work with defaults: ten frames of an 8-bit SDR 4K source encoded at 1080p, no pre-roll.
 * @param overrides - Fields to change.
 * @returns The work.
 */
function work(overrides: Partial<JobWork> = {}): JobWork {
  return { encodedFrames: 10, prerollFrames: 0, sourceWidth: 3840, sourceHeight: 2160, outputWidth: 1920, outputHeight: 1080, bitDepth: 8, hdr: false, ...overrides };
}

/**
 * Rates with every rate set to one value.
 * @param rate - The rate.
 * @returns The rates with 7 s start.
 */
function uniform(rate: number): ClassRates {
  return { startSeconds: 7, encodePixelsPerSecond: rate, decodeConvertPixelsPerSecond: { sdr_8bit: rate, sdr_10bit: rate, sdr_12bit: rate, hdr_8bit: rate, hdr_10bit: rate, hdr_12bit: rate } };
}

describe('ES §5.4 job estimate', () => {
  it('ES01 seconds are the start seconds plus (encoded + pre-roll frames) × (source pixels ÷ decode-convert rate + output pixels ÷ encode rate)', () => {
    const estimate = required('estimateVideoJobSeconds');
    expect(estimate(work(), RATES)).toBe(23);
    expect(estimate(work({ prerollFrames: 5 }), RATES)).toBe(33);
    expect(estimate(work({ bitDepth: 10 }), RATES)).toBe(33);
    expect(estimate(work({ hdr: true }), RATES)).toBe(43);
    expect(estimate(work({ bitDepth: 10, hdr: true }), RATES)).toBe(53);
    // S6d D1-3 (§91): 12-bit sources (ProRes 4444 decodes as 12-bit) have their own measured rates.
    expect(estimate(work({ bitDepth: 12 }), RATES)).toBe(63);
    expect(estimate(work({ bitDepth: 12, hdr: true }), RATES)).toBe(73);
    // Decode counts source pixels and encode output pixels: a 1080p source encoded at 4K costs 1/4 s to decode and 4 s to encode per frame.
    expect(estimate(work({ sourceWidth: 1920, sourceHeight: 1080, outputWidth: 3840, outputHeight: 2160 }), RATES)).toBe(45.5);
  });

  it('ES02 the estimate grows with frames, pre-roll, source and output pixels and shrinks with either rate (property)', () => {
    const estimate = required('estimateVideoJobSeconds');
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 8192 }), fc.integer({ min: 1, max: 8192 }), fc.integer({ min: 1, max: 1_000_000_000 }), (frames, preroll, width, height, rate) => {
      const job = work({ encodedFrames: frames, prerollFrames: preroll, sourceWidth: width, sourceHeight: height, outputWidth: height, outputHeight: width });
      const base = estimate(job, uniform(rate));
      expect(base).toBeGreaterThan(7);
      expect(estimate({ ...job, encodedFrames: frames + 1 }, uniform(rate))).toBeGreaterThan(base);
      expect(estimate({ ...job, prerollFrames: preroll + 1 }, uniform(rate))).toBeGreaterThan(base);
      expect(estimate({ ...job, sourceWidth: width + 1 }, uniform(rate))).toBeGreaterThan(base);
      expect(estimate({ ...job, outputWidth: height + 1 }, uniform(rate))).toBeGreaterThan(base);
      expect(estimate(job, { ...uniform(rate), encodePixelsPerSecond: rate * 2 })).toBeLessThan(base);
      expect(estimate(job, { ...uniform(rate), decodeConvertPixelsPerSecond: { ...uniform(rate).decodeConvertPixelsPerSecond, sdr_8bit: rate * 2 } })).toBeLessThan(base);
    }), { seed: 130803, numRuns: 200 });
  });

  it.each([
    ['zero encoded frames', work({ encodedFrames: 0 }), RATES], ['negative pre-roll', work({ prerollFrames: -1 }), RATES],
    ['zero source width', work({ sourceWidth: 0 }), RATES], ['zero output width', work({ outputWidth: 0 }), RATES],
    ['fractional frames', work({ encodedFrames: 1.5 }), RATES], ['a 16-bit source', work({ bitDepth: 16 as 8 }), RATES],
    ['zero encode rate', work(), { ...RATES, encodePixelsPerSecond: 0 }],
    ['zero decode-convert rate', work(), { ...RATES, decodeConvertPixelsPerSecond: { ...RATES.decodeConvertPixelsPerSecond, sdr_8bit: 0 } }],
    ['negative start seconds', work(), { ...RATES, startSeconds: -1 }],
  ])('ES03 rejects %s', (_, job, rates) => {
    const estimate = required('estimateVideoJobSeconds');
    expect(() => estimate(job, rates)).toThrow(RangeError);
  });
});

/**
 * Keyframe flags with a fixed GOP.
 * @param frames - Frame count.
 * @param gop - Keyframe interval.
 * @returns The flags.
 */
function regular(frames: number, gop: number): boolean[] {
  return Array.from({ length: frames }, (_, index) => index % gop === 0);
}

/**
 * Assert that chunks tile [0, frames) and every inner boundary is a keyframe.
 * @param chunks - The chunks.
 * @param keyframes - The flags.
 */
function expectKeyframeTiling(chunks: readonly Chunk[], keyframes: readonly boolean[]): void {
  expect(chunks.length).toBeGreaterThanOrEqual(1);
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(keyframes.length);
  chunks.forEach((chunk, index) => {
    expect(chunk.end).toBeGreaterThan(chunk.start);
    if (index > 0) {
      expect(chunk.start).toBe(chunks[index - 1]!.end);
      expect(keyframes[chunk.start]).toBe(true);
    }
  });
}

describe('CK §5.4 chunk boundaries at source keyframes', () => {
  it('CK01 each boundary is the keyframe nearest its target', () => {
    // GOP 30, target 40 frames: 30 is nearer 40 than 60; from 30 the target 70 is nearer 60; from 60 the end 100 is the target.
    expect(required('planVideoEncodeChunks')({ keyframes: regular(100, 30), frameSeconds: 1, targetSeconds: 40 })).toEqual([{ start: 0, end: 30 }, { start: 30, end: 60 }, { start: 60, end: 100 }]);
  });

  it('CK02 a source with no keyframe after the first is one chunk whatever the target', () => {
    const keyframes = [true, ...Array.from({ length: 99 }, () => false)];
    expect(required('planVideoEncodeChunks')({ keyframes, frameSeconds: 1, targetSeconds: 10 })).toEqual([{ start: 0, end: 100 }]);
  });

  it('CK03 work that fits the target is one chunk', () => {
    expect(required('planVideoEncodeChunks')({ keyframes: regular(100, 10), frameSeconds: 0.5, targetSeconds: 50 })).toEqual([{ start: 0, end: 100 }]);
  });

  it('CK04 a first frame that is not a keyframe still starts the first chunk', () => {
    const keyframes = regular(60, 20).map((_, index) => index === 7 || index === 27 || index === 47);
    expect(required('planVideoEncodeChunks')({ keyframes, frameSeconds: 1, targetSeconds: 22 })).toEqual([{ start: 0, end: 27 }, { start: 27, end: 47 }, { start: 47, end: 60 }]);
  });

  it('CK05 chunks cover every frame exactly once and break only at keyframes (property)', () => {
    const plan = required('planVideoEncodeChunks');
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 400 }), fc.integer({ min: 1, max: 100 }), (flags, target) => {
      const keyframes = [true, ...flags.slice(1)];
      expectKeyframeTiling(plan({ keyframes, frameSeconds: 1, targetSeconds: target }), keyframes);
    }), { seed: 130804, numRuns: 300 });
  });

  it('CK06 with a regular GOP, more frames or a smaller target never gives fewer chunks (property)', () => {
    const plan = required('planVideoEncodeChunks');
    fc.assert(fc.property(fc.integer({ min: 1, max: 600 }), fc.integer({ min: 1, max: 60 }), fc.integer({ min: 1, max: 300 }), fc.integer({ min: 1, max: 100 }), (frames, gop, target, more) => {
      const count = plan({ keyframes: regular(frames, gop), frameSeconds: 1, targetSeconds: target }).length;
      expect(plan({ keyframes: regular(frames + more, gop), frameSeconds: 1, targetSeconds: target }).length).toBeGreaterThanOrEqual(count);
      expect(plan({ keyframes: regular(frames, gop), frameSeconds: 1, targetSeconds: Math.max(1, target - more) }).length).toBeGreaterThanOrEqual(count);
    }), { seed: 130805, numRuns: 300 });
  });

  it.each([
    ['no frames', { keyframes: [], frameSeconds: 1, targetSeconds: 1 }],
    ['zero frame work', { keyframes: [true], frameSeconds: 0, targetSeconds: 1 }],
    ['zero target', { keyframes: [true], frameSeconds: 1, targetSeconds: 0 }],
  ])('CK07 rejects %s', (_, input) => {
    const plan = required('planVideoEncodeChunks');
    expect(() => plan(input)).toThrow(RangeError);
  });

  it('CK09 two equally near keyframes resolve to the earlier', () => {
    // GOP 30, target 45: 30 and 60 are both 15 from 45 (take 30); from 30, 60 and 90 are both 15 from 75 (take 60); from 60 the end is nearest.
    const plan = required('planVideoEncodeChunks');
    expect(plan({ keyframes: regular(100, 30), frameSeconds: 1, targetSeconds: 45 })).toEqual([{ start: 0, end: 30 }, { start: 30, end: 60 }, { start: 60, end: 100 }]);
  });

  it('CK08 presentation needing more chunks than the parallel cap fails as too_long, within it does not', () => {
    const failure = required('presentationEncodeFailure');
    expect(failure(9, 8)).toBe('too_long');
    expect(failure(8, 8)).toBeNull();
    expect(failure(1, 8)).toBeNull();
  });
});

describe('JI §5.4 container job identities', () => {
  const task = '7d1c0e8a-3b5f-4a9e-8c21-5f0d3e6a9b10';
  it.each([
    [{ kind: 'presentation-probe', jobId: 'job-1' }, 'video-presentation:job-1'],
    [{ kind: 'presentation-chunk', jobId: 'job-1', chunk: 0, attempt: 1 }, 'video-presentation:job-1:chunk:0:a1'],
    [{ kind: 'presentation-chunk', jobId: 'job-1', chunk: 3, attempt: 1 }, 'video-presentation:job-1:chunk:3:a1'],
    [{ kind: 'run-chunk', taskId: task, output: 0, chunk: 0, attempt: 1 }, `${task}:out:0:enc:0:a1`],
    [{ kind: 'prep', taskId: task, input: 0, attempt: 1 }, `${task}:prep:0:a1`],
    [{ kind: 'presentation-stitch', jobId: 'job-1', attempt: 2 }, 'video-presentation:job-1:stitch:a2'],
    [{ kind: 'presentation-copy', jobId: 'job-1', attempt: 1 }, 'video-presentation:job-1:copy:a1'],
    [{ kind: 'run-batch', taskId: task, batch: 0, attempt: 1 }, `${task}:batch:0:a1`],
    [{ kind: 'run-chunk', taskId: task, output: 2, chunk: 5, attempt: 3 }, `${task}:out:2:enc:5:a3`],
    [{ kind: 'run-stitch', taskId: task, output: 2, attempt: 1 }, `${task}:out:2:stitch:a1`],
    [{ kind: 'prep', taskId: task, input: 1, attempt: 1 }, `${task}:prep:1:a1`],
    [{ kind: 'prep-chunk', taskId: task, input: 1, chunk: 4, attempt: 2 }, `${task}:prep:1:enc:4:a2`],
    [{ kind: 'prep-stitch', taskId: task, input: 1, attempt: 1 }, `${task}:prep:1:stitch:a1`],
  ] as const)('JI01 %o is %s', (spec, id) => {
    expect(required('videoContainerJobId')(spec)).toBe(id);
  });

  it.each([
    ['attempt 0', { kind: 'presentation-stitch', jobId: 'job-1', attempt: 0 }],
    ['a fractional attempt', { kind: 'run-batch', taskId: task, batch: 0, attempt: 1.5 }],
    ['a negative chunk', { kind: 'presentation-chunk', jobId: 'job-1', chunk: -1, attempt: 1 }],
    ['a fractional output', { kind: 'run-stitch', taskId: task, output: 0.5, attempt: 1 }],
    ['an empty job id', { kind: 'presentation-probe', jobId: '' }],
    ['an empty task id', { kind: 'prep', taskId: '', input: 0, attempt: 1 }],
  ] as const)('JI02 rejects %s', (_, spec) => {
    const id = required('videoContainerJobId');
    expect(() => id(spec as JobSpec)).toThrow(RangeError);
  });

  it('JI03 distinct identities, attempts included, never share a job id (property)', () => {
    const id = required('videoContainerJobId');
    const name = fc.stringMatching(/^[a-z0-9-]{1,12}$/);
    const n = fc.integer({ min: 0, max: 20 });
    const m = fc.integer({ min: 1, max: 5 });
    const spec: fc.Arbitrary<JobSpec> = fc.oneof(
      fc.record({ kind: fc.constant('presentation-probe' as const), jobId: name }),
      fc.record({ kind: fc.constant('presentation-chunk' as const), jobId: name, chunk: n, attempt: m }),
      fc.record({ kind: fc.constant('presentation-stitch' as const), jobId: name, attempt: m }),
      fc.record({ kind: fc.constant('presentation-copy' as const), jobId: name, attempt: m }),
      fc.record({ kind: fc.constant('run-batch' as const), taskId: name, batch: n, attempt: m }),
      fc.record({ kind: fc.constant('run-chunk' as const), taskId: name, output: n, chunk: n, attempt: m }),
      fc.record({ kind: fc.constant('run-stitch' as const), taskId: name, output: n, attempt: m }),
      fc.record({ kind: fc.constant('prep' as const), taskId: name, input: n, attempt: m }),
      fc.record({ kind: fc.constant('prep-chunk' as const), taskId: name, input: n, chunk: n, attempt: m }),
      fc.record({ kind: fc.constant('prep-stitch' as const), taskId: name, input: n, attempt: m }),
    );
    fc.assert(fc.property(fc.uniqueArray(spec, { minLength: 2, maxLength: 40, selector: (value) => JSON.stringify(value) }), (specs) => {
      expect(new Set(specs.map(id)).size).toBe(specs.length);
    }), { seed: 130806, numRuns: 200 });
  });
});

describe('BT §5.4 user-run batching', () => {
  it('BT01 batches in stable order under both caps and sets an oversized output aside for chunk encoding', () => {
    // Share 10 s, 1 s fixed per job, 2 outputs per job: [0,1] holds 7 s, [2,4] holds 7 s, output 3 alone needs 11 s.
    expect(required('batchVideoRunOutputs')([3, 3, 3, 10, 3], { maxOutputsPerJob: 2, shareSeconds: 10, fixedSeconds: 1 })).toEqual({ batches: [[0, 1], [2, 4]], oversized: [3] });
  });

  it('BT02 the work cap splits a batch before the output cap does', () => {
    expect(required('batchVideoRunOutputs')([4, 4, 4, 4], { maxOutputsPerJob: 8, shareSeconds: 10, fixedSeconds: 1 })).toEqual({ batches: [[0, 1], [2, 3]], oversized: [] });
  });

  it('BT03 never exceeds either cap and places every output exactly once in order (property)', () => {
    const batch = required('batchVideoRunOutputs');
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 60 }), fc.integer({ min: 1, max: MINI_TOOL_JOB_MAX_OUTPUTS }), fc.integer({ min: 5, max: 40 }), fc.integer({ min: 0, max: 4 }), (works, perJob, share, fixed) => {
      const { batches, oversized } = batch(works, { maxOutputsPerJob: perJob, shareSeconds: share, fixedSeconds: fixed });
      for (const group of batches) {
        expect(group.length).toBeGreaterThanOrEqual(1);
        expect(group.length).toBeLessThanOrEqual(perJob);
        expect(fixed + group.reduce((total, index) => total + works[index]!, 0)).toBeLessThanOrEqual(share);
      }
      for (const index of oversized) expect(fixed + works[index]!).toBeGreaterThan(share);
      const placed = [...batches.flat(), ...oversized].sort((a, b) => a - b);
      expect(placed).toEqual(works.map((_, index) => index));
      const order = batches.flat();
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }), { seed: 130807, numRuns: 300 });
  });

  it.each([0, MINI_TOOL_JOB_MAX_OUTPUTS + 1, 1.5])('BT04 rejects %s outputs per job', (maxOutputsPerJob) => {
    const batch = required('batchVideoRunOutputs');
    expect(() => batch([1], { maxOutputsPerJob, shareSeconds: 10, fixedSeconds: 1 })).toThrow(RangeError);
  });
});

// A packed alpha carrier holds the colour plane, a 4-column gap and the alpha plane side by side (§3.5 alpha-packed).
describe('packed carrier width', () => {
  it('is two planes and the gap, and gives the plane back', () => {
    const plan = miniTools as unknown as { packedCarrierWidth: (plane: number) => number; packedPlaneWidth: (packed: number) => number };
    expect(plan.packedCarrierWidth(320)).toBe(644);
    expect(plan.packedPlaneWidth(644)).toBe(320);
  });
});
