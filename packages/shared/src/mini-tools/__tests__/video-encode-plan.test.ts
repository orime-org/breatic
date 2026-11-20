// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared encode planning on the frame grid: HDR transfers, carrier geometry, work estimate, chunk boundaries, job
 * identities and user-run batching (inner#1306; frames-split design §4.3, §5.4, §8.2). The route choice and the route
 * stages are specified in `frame-grid-plan.test.ts` and `packages/ingest/src/__tests__/frame-grid-routes.test.ts`; the
 * identity, copy and dispatched-copy routes and the unaltered-mapping check are gone with the frame table (§3.4, §7.1).
 *
 * Every expected value is written from the approved design: HDR transfers are smpte2084 and arib-std-b67; an encoded
 * carrier whose short side exceeds 1080 scales to short side 1080 with the long side rounded as FFmpeg `scale=-2`,
 * otherwise odd sides pad to even and record the picture rectangle; a job's seconds are its start seconds plus (encoded +
 * pre-roll frames) × (source pixels over the tool source's decode rate + output pixels over the encode rate), with no
 * download term (§5.4 估算 row; the per-key cases are in `frame-grid-decode-key.node.test.ts`); chunk boundaries divide
 * the grid's frames evenly into the fewest chunks whose frames and pre-roll fit the target (§5.4 切块 row); job ids follow
 * the §5.4 formats with indices from 0 and attempts from 1; batches respect both caps.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as miniTools from '../index.js';
import { MINI_TOOL_JOB_MAX_OUTPUTS } from '../../upload/mini-tool-job.js';

interface Rect { x: number; y: number; width: number; height: number }
interface JobWork { encodedFrames: number; prerollFrames: number; sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number; decodeKey: string; encodeKey: string | null; toneMap: boolean }
interface ClassRates { startSeconds: number; encodePixelsPerSecond: number; tonemapPixelsPerSecond: number; decodeConvertPixelsPerSecond: Record<string, number>; editEncodePixelsPerSecond: Record<string, number> }
interface Chunk { start: number; end: number }
type JobSpec =
  | { kind: 'presentation-probe'; jobId: string }
  | { kind: 'presentation-chunk'; jobId: string; chunk: number; attempt: number }
  | { kind: 'presentation-stitch'; jobId: string; attempt: number }
  | { kind: 'presentation-count'; jobId: string; attempt: number }
  | { kind: 'presentation-edit'; jobId: string; chunk: number; attempt: number }
  | { kind: 'presentation-edit-stitch'; jobId: string; attempt: number }
  | { kind: 'run-batch'; taskId: string; batch: number; attempt: number }
  | { kind: 'run-chunk'; taskId: string; output: number; chunk: number; attempt: number }
  | { kind: 'run-stitch'; taskId: string; output: number; attempt: number };
interface EncodeApi {
  isHdrTransfer: (transfer: string | null | undefined) => boolean;
  videoCarrierGeometry: (display: { width: number; height: number }, maxShortSide: number) => { width: number; height: number; displayRect: Rect | null };
  estimateVideoJobSeconds: (work: JobWork, rates: ClassRates) => number;
  planVideoEncodeChunks: (input: { frameCount: number; frameSeconds: number; prerollFrames: number; targetSeconds: number }) => Chunk[];
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

describe('H §4.3 HDR transfers', () => {
  it.each(['smpte2084', 'arib-std-b67'])('H01 %s is HDR', (transfer) => {
    expect(required('isHdrTransfer')(transfer)).toBe(true);
  });
  it.each(['bt709', 'smpte170m', 'bt2020-10', 'unknown', '', null, undefined])('H02 %s is not HDR', (transfer) => {
    expect(required('isHdrTransfer')(transfer)).toBe(false);
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

// Test rates chosen so each term is whole seconds: one 1080p output frame encodes in 1 s at the playback rate and 2 s at the
// 8-bit 4:2:0 edit tier; one 4K source frame decodes in 1 s (sdr_8bit), 2 s (sdr_10bit) or 5 s (sdr_prores) and tone maps in 3 s.
const RATES: ClassRates = {
  startSeconds: 3, encodePixelsPerSecond: 2_073_600, tonemapPixelsPerSecond: 2_764_800,
  decodeConvertPixelsPerSecond: { sdr_8bit: 8_294_400, sdr_10bit: 4_147_200, sdr_prores: 1_658_880, edit_h264_intra_8bit_420: 8_294_400 },
  editEncodePixelsPerSecond: { edit_h264_intra_8bit_420: 1_036_800 },
};

/**
 * A job's work with defaults: ten frames of an 8-bit SDR 4K original encoded to a 1080p playback chunk, no pre-roll.
 * @param overrides - Fields to change.
 * @returns The work.
 */
function work(overrides: Partial<JobWork> = {}): JobWork {
  return { encodedFrames: 10, prerollFrames: 0, sourceWidth: 3840, sourceHeight: 2160, outputWidth: 1920, outputHeight: 1080, decodeKey: 'sdr_8bit', encodeKey: 'playback', toneMap: false, ...overrides };
}

/**
 * Rates with every rate set to one value.
 * @param rate - The rate.
 * @returns The rates with 7 s start.
 */
function uniform(rate: number): ClassRates {
  return { startSeconds: 7, encodePixelsPerSecond: rate, tonemapPixelsPerSecond: rate, decodeConvertPixelsPerSecond: { sdr_8bit: rate }, editEncodePixelsPerSecond: {} };
}

describe('ES §5.4 job estimate', () => {
  it('ES01 seconds are the start seconds plus (encoded + pre-roll frames) × (source pixels ÷ decode rate [+ ÷ tone-map rate] + output pixels ÷ encode rate)', () => {
    const estimate = required('estimateVideoJobSeconds');
    expect(estimate(work(), RATES)).toBe(23);
    expect(estimate(work({ prerollFrames: 5 }), RATES)).toBe(33);
    expect(estimate(work({ decodeKey: 'sdr_10bit' }), RATES)).toBe(33);
    expect(estimate(work({ decodeKey: 'sdr_prores' }), RATES)).toBe(63);
    // An HDR original's edit_encode: decode, tone map and encode at the edit tier.
    expect(estimate(work({ decodeKey: 'sdr_prores', encodeKey: 'edit_h264_intra_8bit_420', toneMap: true }), RATES)).toBe(103);
    // The decode-only count has no encode term.
    expect(estimate(work({ encodeKey: null }), RATES)).toBe(13);
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
      expect(estimate(job, { ...uniform(rate), decodeConvertPixelsPerSecond: { sdr_8bit: rate * 2 } })).toBeLessThan(base);
    }), { seed: 130803, numRuns: 200 });
  });

  it.each([
    ['zero encoded frames', work({ encodedFrames: 0 }), RATES], ['negative pre-roll', work({ prerollFrames: -1 }), RATES],
    ['zero source width', work({ sourceWidth: 0 }), RATES], ['zero output width', work({ outputWidth: 0 }), RATES],
    ['fractional frames', work({ encodedFrames: 1.5 }), RATES], ['a decode key without a rate', work({ decodeKey: 'sdr_ffv1' }), RATES],
    ['zero encode rate', work(), { ...RATES, encodePixelsPerSecond: 0 }],
    ['zero decode-convert rate', work(), { ...RATES, decodeConvertPixelsPerSecond: { ...RATES.decodeConvertPixelsPerSecond, sdr_8bit: 0 } }],
    ['negative start seconds', work(), { ...RATES, startSeconds: -1 }],
  ])('ES03 rejects %s', (_, job, rates) => {
    const estimate = required('estimateVideoJobSeconds');
    expect(() => estimate(job, rates)).toThrow(RangeError);
  });
});

/**
 * Assert that chunks tile [0, frames) without gaps.
 * @param chunks - The chunks.
 * @param frames - The frame count.
 */
function expectTiling(chunks: readonly Chunk[], frames: number): void {
  expect(chunks.length).toBeGreaterThanOrEqual(1);
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(frames);
  chunks.forEach((chunk, index) => {
    expect(chunk.end).toBeGreaterThan(chunk.start);
    if (index > 0) expect(chunk.start).toBe(chunks[index - 1]!.end);
  });
}

describe('CK §5.4 chunk boundaries divide the grid frames evenly', () => {
  it('CK01 the fewest even chunks whose frames and pre-roll fit the target', () => {
    // 100 frames of 1 s, target 40 with 10 frames of pre-roll: 30 frames a chunk at most, so 4 chunks of 25.
    expect(required('planVideoEncodeChunks')({ frameCount: 100, frameSeconds: 1, prerollFrames: 10, targetSeconds: 40 }))
      .toEqual([{ start: 0, end: 25 }, { start: 25, end: 50 }, { start: 50, end: 75 }, { start: 75, end: 100 }]);
  });

  it('CK03 work that fits the target is one chunk', () => {
    expect(required('planVideoEncodeChunks')({ frameCount: 100, frameSeconds: 0.5, prerollFrames: 0, targetSeconds: 50 })).toEqual([{ start: 0, end: 100 }]);
  });

  it('CK04 a pre-roll that alone fills the target gives every frame its own chunk', () => {
    expect(required('planVideoEncodeChunks')({ frameCount: 3, frameSeconds: 1, prerollFrames: 40, targetSeconds: 40 })).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]);
  });

  it('CK05 chunks cover every frame exactly once, each within the target when one frame and the pre-roll fit (property)', () => {
    const plan = required('planVideoEncodeChunks');
    fc.assert(fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 0, max: 50 }), fc.integer({ min: 1, max: 400 }), (frames, preroll, target) => {
      const chunks = plan({ frameCount: frames, frameSeconds: 1, prerollFrames: preroll, targetSeconds: target });
      expectTiling(chunks, frames);
      if (preroll + 1 <= target) for (const chunk of chunks) expect(chunk.end - chunk.start + preroll).toBeLessThanOrEqual(target);
    }), { seed: 130804, numRuns: 300 });
  });

  it('CK06 more frames or a smaller target never gives fewer chunks (property)', () => {
    const plan = required('planVideoEncodeChunks');
    fc.assert(fc.property(fc.integer({ min: 1, max: 600 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 1, max: 300 }), fc.integer({ min: 1, max: 100 }), (frames, preroll, target, more) => {
      const count = plan({ frameCount: frames, frameSeconds: 1, prerollFrames: preroll, targetSeconds: target }).length;
      expect(plan({ frameCount: frames + more, frameSeconds: 1, prerollFrames: preroll, targetSeconds: target }).length).toBeGreaterThanOrEqual(count);
      expect(plan({ frameCount: frames, frameSeconds: 1, prerollFrames: preroll, targetSeconds: Math.max(1, target - more) }).length).toBeGreaterThanOrEqual(count);
    }), { seed: 130805, numRuns: 300 });
  });

  it.each([
    ['no frames', { frameCount: 0, frameSeconds: 1, prerollFrames: 0, targetSeconds: 1 }],
    ['zero frame work', { frameCount: 1, frameSeconds: 0, prerollFrames: 0, targetSeconds: 1 }],
    ['zero target', { frameCount: 1, frameSeconds: 1, prerollFrames: 0, targetSeconds: 0 }],
    ['negative pre-roll', { frameCount: 1, frameSeconds: 1, prerollFrames: -1, targetSeconds: 1 }],
  ])('CK07 rejects %s', (_, input) => {
    const plan = required('planVideoEncodeChunks');
    expect(() => plan(input)).toThrow(RangeError);
  });
});

describe('JI §5.4 container job identities', () => {
  const task = '7d1c0e8a-3b5f-4a9e-8c21-5f0d3e6a9b10';
  it.each([
    [{ kind: 'presentation-probe', jobId: 'job-1' }, 'video-presentation:job-1'],
    [{ kind: 'presentation-chunk', jobId: 'job-1', chunk: 0, attempt: 1 }, 'video-presentation:job-1:chunk:0:a1'],
    [{ kind: 'presentation-chunk', jobId: 'job-1', chunk: 3, attempt: 1 }, 'video-presentation:job-1:chunk:3:a1'],
    [{ kind: 'run-chunk', taskId: task, output: 0, chunk: 0, attempt: 1 }, `${task}:out:0:enc:0:a1`],
    [{ kind: 'presentation-stitch', jobId: 'job-1', attempt: 2 }, 'video-presentation:job-1:stitch:a2'],
    [{ kind: 'presentation-count', jobId: 'job-1', attempt: 1 }, 'video-presentation:job-1:count:a1'],
    [{ kind: 'presentation-edit', jobId: 'job-1', chunk: 2, attempt: 1 }, 'video-presentation:job-1:edit:2:a1'],
    [{ kind: 'presentation-edit-stitch', jobId: 'job-1', attempt: 3 }, 'video-presentation:job-1:edit-stitch:a3'],
    [{ kind: 'run-batch', taskId: task, batch: 0, attempt: 1 }, `${task}:batch:0:a1`],
    [{ kind: 'run-chunk', taskId: task, output: 2, chunk: 5, attempt: 3 }, `${task}:out:2:enc:5:a3`],
    [{ kind: 'run-stitch', taskId: task, output: 2, attempt: 1 }, `${task}:out:2:stitch:a1`],
  ] as const)('JI01 %o is %s', (spec, id) => {
    expect(required('videoContainerJobId')(spec)).toBe(id);
  });

  it.each([
    ['attempt 0', { kind: 'presentation-stitch', jobId: 'job-1', attempt: 0 }],
    ['a fractional attempt', { kind: 'run-batch', taskId: task, batch: 0, attempt: 1.5 }],
    ['a negative chunk', { kind: 'presentation-chunk', jobId: 'job-1', chunk: -1, attempt: 1 }],
    ['a fractional output', { kind: 'run-stitch', taskId: task, output: 0.5, attempt: 1 }],
    ['an empty job id', { kind: 'presentation-probe', jobId: '' }],
    ['an empty task id', { kind: 'run-batch', taskId: '', batch: 0, attempt: 1 }],
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
      fc.record({ kind: fc.constant('presentation-count' as const), jobId: name, attempt: m }),
      fc.record({ kind: fc.constant('presentation-edit' as const), jobId: name, chunk: n, attempt: m }),
      fc.record({ kind: fc.constant('presentation-edit-stitch' as const), jobId: name, attempt: m }),
      fc.record({ kind: fc.constant('run-batch' as const), taskId: name, batch: n, attempt: m }),
      fc.record({ kind: fc.constant('run-chunk' as const), taskId: name, output: n, chunk: n, attempt: m }),
      fc.record({ kind: fc.constant('run-stitch' as const), taskId: name, output: n, attempt: m }),
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
