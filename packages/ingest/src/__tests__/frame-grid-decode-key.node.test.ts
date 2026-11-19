// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Probe facts that decide the presentation's cost: the source decode-rate key, the five edit-file tiers, which keys each
 * stage reads, the tone-map term, whether the original can serve as the tool source and the whole route's time budget
 * (inner#1306 test plan §65.1 K01–K05, E01, E02; frames-split design §3.2 item 7, §4.2, §5.4 估算 and 上限 rows, §10.12
 * frame-grid-rate.ts / video-encode-plan.ts rows). The grid count (E03) is the shared `planFrameGrid`, which the container's
 * grid_count recipe calls; it is tested once, in `packages/shared/src/upload/__tests__/frame-grid.test.ts`.
 *
 * Modules are read at call time so a missing module or export fails each case on its own.
 */

import { describe, expect, it } from 'vitest';
import { videoPresentationEncodingSchema } from '@shared/upload/video-presentation-policy.js';
import * as plan from '@shared/mini-tools/video-encode-plan.js';

type Alpha = 'confirmed_alpha' | 'confirmed_opaque';
interface DecodeSource { codec: string; bitDepth: number; alpha: Alpha }
type SourceKey = keyof typeof SOURCE_RATES;
type EditTier = (typeof EDIT_TIERS)[number];
type DecodeKey = SourceKey | EditTier;
interface StageWork {
  encodedFrames: number; prerollFrames: number; sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number;
  decodeKey: DecodeKey; encodeKey: 'playback' | EditTier | null; toneMap: boolean;
}
interface Rates {
  startSeconds: number; encodePixelsPerSecond: number; tonemapPixelsPerSecond: number;
  decodeConvertPixelsPerSecond: Record<DecodeKey, number>; editEncodePixelsPerSecond: Record<EditTier, number>; aacEncodeSecondsPerSecond: number;
}
interface StageKeys { decodeKey: DecodeKey; encodeKey: 'playback' | EditTier | null; toneMap: boolean }
interface RouteStage { stage: string; chunked: boolean; jobSeconds: number[] }

// §4.2 and §5.4 估算 row: one decode and one encode rate per edit tier, named after the config keys without `_pixels_per_second`.
const EDIT_TIERS = ['edit_h264_intra_8bit_420', 'edit_h264_intra_10bit_420', 'edit_h264_intra_8bit_444', 'edit_h264_intra_10bit_444', 'edit_prores'] as const;

// §5.4 估算 row: the closed decode-key table (sdr_16bit and the four hdr_* keys are gone), at the maintainer readings
// (pixels per second), each key distinct so a wrong key changes the estimate.
const SOURCE_RATES = {
  sdr_8bit: 910e6, sdr_10bit: 810e6, sdr_12bit: 690e6, sdr_alpha_layer: 600e6, sdr_prores: 820e6, sdr_dnx: 735e6,
  sdr_av1_8bit: 740e6, sdr_av1_10bit: 570e6, sdr_av1_12bit: 610e6, sdr_jpeg2000: 25e6, sdr_ffv1: 75e6, sdr_png: 340e6, sdr_other: 1080e6,
} as const satisfies Record<string, number>;
const EDIT_DECODE: Record<EditTier, number> = {
  edit_h264_intra_8bit_420: 1500e6, edit_h264_intra_10bit_420: 1200e6, edit_h264_intra_8bit_444: 1100e6, edit_h264_intra_10bit_444: 900e6, edit_prores: 950e6,
};
const EDIT_ENCODE: Record<EditTier, number> = {
  edit_h264_intra_8bit_420: 300e6, edit_h264_intra_10bit_420: 250e6, edit_h264_intra_8bit_444: 200e6, edit_h264_intra_10bit_444: 180e6, edit_prores: 400e6,
};
const RATES: Rates = {
  startSeconds: 3, encodePixelsPerSecond: 248e6, tonemapPixelsPerSecond: 1170e6,
  decodeConvertPixelsPerSecond: { ...SOURCE_RATES, ...EDIT_DECODE }, editEncodePixelsPerSecond: EDIT_ENCODE, aacEncodeSecondsPerSecond: 100,
};

/**
 * The shared frame-grid module, loaded at call time so its absence fails each case alone.
 * @returns The module's exports.
 */
async function frameGrid(): Promise<Record<string, unknown>> {
  return await import('@shared/upload/frame-grid-rate.js') as Record<string, unknown>;
}

/**
 * One named function of a module, checked to exist.
 * @param module - The module's exports.
 * @param name - The export.
 * @param where - The module path, for the message.
 * @returns It.
 */
function fn<F>(module: Record<string, unknown>, name: string, where: string): F {
  expect(module[name], `${name} is exported from ${where}`).toBeTypeOf('function');
  return module[name] as F;
}

/**
 * `sourceDecodeKey` from the shared frame-grid module (§3.2 item 7, §10.12).
 * @returns It.
 */
async function decodeKey(): Promise<(source: DecodeSource, rates: Readonly<Record<SourceKey, number>>) => SourceKey> {
  return fn(await frameGrid(), 'sourceDecodeKey', '@shared/upload/frame-grid-rate.js');
}

/**
 * The job estimate over the decode key, encode key and tone-map flag (§5.4 估算 row).
 * @param work - The job.
 * @returns The seconds.
 */
function estimate(work: StageWork): number {
  return fn<(work: StageWork, rates: Rates) => number>(plan, 'estimateVideoJobSeconds', '@shared/mini-tools/video-encode-plan.js')(work, RATES);
}

const WORK = { encodedFrames: 300, prerollFrames: 0, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1920, outputHeight: 1080 };
const SOURCE_PIXELS = WORK.sourceWidth * WORK.sourceHeight;
const OUTPUT_PIXELS = WORK.outputWidth * WORK.outputHeight;

describe('K01 the source decode-rate key: codec first, then bit depth (design §5.4 估算 row)', () => {
  it.each([
    ['16-bit FFV1', { codec: 'ffv1', bitDepth: 16, alpha: 'confirmed_opaque' }, 'sdr_ffv1'],
    ['12-bit JPEG 2000', { codec: 'jpeg2000', bitDepth: 12, alpha: 'confirmed_opaque' }, 'sdr_jpeg2000'],
    ['16-bit PNG', { codec: 'png', bitDepth: 16, alpha: 'confirmed_alpha' }, 'sdr_png'],
    ['MPEG-2', { codec: 'mpeg2video', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_other'],
    ['MJPEG', { codec: 'mjpeg', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_other'],
    ['VC-1', { codec: 'vc1', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_other'],
    ['Theora', { codec: 'theora', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_other'],
    ['QuickTime RLE', { codec: 'qtrle', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_other'],
    ['12-bit HEVC, not the ProRes reading', { codec: 'hevc', bitDepth: 12, alpha: 'confirmed_opaque' }, 'sdr_12bit'],
    ['8-bit H.264', { codec: 'h264', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_8bit'],
    ['10-bit H.264', { codec: 'h264', bitDepth: 10, alpha: 'confirmed_opaque' }, 'sdr_10bit'],
    ['opaque 8-bit VP9', { codec: 'vp9', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_8bit'],
    ['MPEG-4 Part 2', { codec: 'mpeg4', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_8bit'],
    ['10-bit ProRes 422', { codec: 'prores', bitDepth: 10, alpha: 'confirmed_opaque' }, 'sdr_prores'],
    ['DNxHR 444', { codec: 'dnxhd', bitDepth: 10, alpha: 'confirmed_opaque' }, 'sdr_dnx'],
    ['8-bit AV1', { codec: 'av1', bitDepth: 8, alpha: 'confirmed_opaque' }, 'sdr_av1_8bit'],
    ['10-bit AV1', { codec: 'av1', bitDepth: 10, alpha: 'confirmed_opaque' }, 'sdr_av1_10bit'],
    ['12-bit AV1', { codec: 'av1', bitDepth: 12, alpha: 'confirmed_opaque' }, 'sdr_av1_12bit'],
    ['VP9 classifyVideoAlpha confirmed transparent', { codec: 'vp9', bitDepth: 8, alpha: 'confirmed_alpha' }, 'sdr_alpha_layer'],
    ['VP8 confirmed transparent', { codec: 'vp8', bitDepth: 8, alpha: 'confirmed_alpha' }, 'sdr_alpha_layer'],
    ['HEVC with an alpha layer', { codec: 'hevc', bitDepth: 8, alpha: 'confirmed_alpha' }, 'sdr_alpha_layer'],
  ] as const)('K01 %s', async (_name, source, expected) => {
    expect((await decodeKey())(source, SOURCE_RATES)).toBe(expected);
  });

  it('K01 an HLG ProRes still takes sdr_prores: the transfer never chooses the key', async () => {
    const hlgProres = { codec: 'prores', bitDepth: 10, alpha: 'confirmed_opaque' as const, transfer: 'arib-std-b67' };
    expect((await decodeKey())(hlgProres, SOURCE_RATES)).toBe('sdr_prores');
  });

  it('K01 an unlisted codec and a 14-bit H.264 take the key of smallest value among all keys', async () => {
    const key = await decodeKey();
    expect(key({ codec: 'cinepak', bitDepth: 8, alpha: 'confirmed_opaque' }, SOURCE_RATES)).toBe('sdr_jpeg2000');
    expect(key({ codec: 'h264', bitDepth: 14, alpha: 'confirmed_opaque' }, SOURCE_RATES)).toBe('sdr_jpeg2000');
    // "取所有键里值最小的一个": the smallest value decides, not a fixed name.
    const slowerFfv1 = { ...SOURCE_RATES, sdr_ffv1: 10e6 };
    expect(key({ codec: 'cinepak', bitDepth: 8, alpha: 'confirmed_opaque' }, slowerFfv1)).toBe('sdr_ffv1');
  });
});

describe('K02 the frozen rate table carries the new keys (design §5.4 估算 row, §10.12 video-encode-plan.ts row)', () => {
  const encoder = videoPresentationEncodingSchema.shape.encoder;

  it('K02 the admission-frozen decode table accepts the thirteen source keys and the five edit_* decode rates', () => {
    const parsed = encoder.shape.decodeConvertPixelsPerSecond.safeParse({ ...SOURCE_RATES, ...EDIT_DECODE });
    expect(parsed.success, parsed.error?.message).toBe(true);
  });

  it('K02 the old depth-and-range table (sdr_16bit and the hdr_* keys) is no longer a frozen decode table', () => {
    const old = { sdr_8bit: 2200e6, sdr_10bit: 1310e6, sdr_12bit: 816e6, hdr_8bit: 106e6, hdr_10bit: 102e6, hdr_12bit: 109e6, sdr_16bit: 294e6, hdr_16bit: 71.9e6 };
    expect(encoder.shape.decodeConvertPixelsPerSecond.safeParse(old).success).toBe(false);
  });

  it('K02 the frozen encoder carries the tone-map rate and the five edit_* encode rates', () => {
    expect(Object.keys(encoder.shape)).toEqual(expect.arrayContaining(['tonemapPixelsPerSecond', 'editEncodePixelsPerSecond']));
  });
});

describe('K03 tone mapping is one term of edit_encode only (design §5.4 估算 row)', () => {
  const stageKeys = (): ((stage: 'count' | 'edit' | 'encode', source: { sourceDecodeKey: SourceKey; hdr: boolean; editTier: EditTier | null }) => StageKeys) =>
    fn(plan, 'presentationStageKeys', '@shared/mini-tools/video-encode-plan.js');

  it('K03 an HDR source: edit_encode adds source pixels ÷ tonemap rate; grid_count does not; the playback encode reads the SDR edit file', () => {
    const source = { sourceDecodeKey: 'sdr_prores' as const, hdr: true, editTier: 'edit_h264_intra_8bit_420' as const };
    expect(stageKeys()('edit', source)).toEqual({ decodeKey: 'sdr_prores', encodeKey: 'edit_h264_intra_8bit_420', toneMap: true });
    expect(stageKeys()('count', source)).toEqual({ decodeKey: 'sdr_prores', encodeKey: null, toneMap: false });
    expect(stageKeys()('encode', source)).toEqual({ decodeKey: 'edit_h264_intra_8bit_420', encodeKey: 'playback', toneMap: false });
  });

  it('K03 an SDR source never tone maps', () => {
    const source = { sourceDecodeKey: 'sdr_8bit' as const, hdr: false, editTier: 'edit_h264_intra_8bit_420' as const };
    for (const stage of ['count', 'edit', 'encode'] as const) expect(stageKeys()(stage, source).toneMap).toBe(false);
  });

  it('K03 the tone-map term is exactly frames × source pixels ÷ tonemapPixelsPerSecond', () => {
    const base = { ...WORK, decodeKey: 'sdr_prores' as const, encodeKey: 'edit_h264_intra_8bit_420' as const };
    const difference = estimate({ ...base, toneMap: true }) - estimate({ ...base, toneMap: false });
    expect(difference).toBeCloseTo((WORK.encodedFrames * SOURCE_PIXELS) / RATES.tonemapPixelsPerSecond, 6);
  });

  it('K03 a decode-only count has no encode term', () => {
    const counted = estimate({ ...WORK, decodeKey: 'sdr_8bit', encodeKey: null, toneMap: false });
    expect(counted).toBeCloseTo(RATES.startSeconds + (WORK.encodedFrames * SOURCE_PIXELS) / SOURCE_RATES.sdr_8bit, 6);
  });
});

describe('K04 the five edit-file tiers and their rates (design §4.2 编辑用文件, §5.4 估算 row)', () => {
  const tier = (): ((source: { alpha: boolean; bitDepth: number; hdr: boolean; width: number; height: number }) => EditTier) =>
    fn(plan, 'editFileTier', '@shared/mini-tools/video-encode-plan.js');

  it.each([
    ['8-bit even', { alpha: false, bitDepth: 8, hdr: false, width: 1920, height: 1080 }, 'edit_h264_intra_8bit_420'],
    ['10-bit SDR even', { alpha: false, bitDepth: 10, hdr: false, width: 1920, height: 1080 }, 'edit_h264_intra_10bit_420'],
    ['8-bit with an odd side', { alpha: false, bitDepth: 8, hdr: false, width: 161, height: 97 }, 'edit_h264_intra_8bit_444'],
    ['12-bit SDR with an odd side', { alpha: false, bitDepth: 12, hdr: false, width: 1920, height: 1081 }, 'edit_h264_intra_10bit_444'],
    ['HDR is tone mapped to 8-bit', { alpha: false, bitDepth: 10, hdr: true, width: 3840, height: 2160 }, 'edit_h264_intra_8bit_420'],
    ['HDR with an odd side', { alpha: false, bitDepth: 10, hdr: true, width: 3841, height: 2160 }, 'edit_h264_intra_8bit_444'],
    ['transparent', { alpha: true, bitDepth: 8, hdr: false, width: 1920, height: 1080 }, 'edit_prores'],
  ] as const)('K04 %s', (_name, source, expected) => {
    expect(tier()(source)).toBe(expected);
  });

  it.each(EDIT_TIERS)('K04 %s: edit_encode encodes at its own encode rate and a read of the edit file decodes at its own decode rate', (editTier) => {
    const encode = estimate({ ...WORK, decodeKey: 'sdr_8bit', encodeKey: editTier, toneMap: false });
    expect(encode).toBeCloseTo(RATES.startSeconds + WORK.encodedFrames * (SOURCE_PIXELS / SOURCE_RATES.sdr_8bit + OUTPUT_PIXELS / EDIT_ENCODE[editTier]), 6);
    const read = estimate({ ...WORK, decodeKey: editTier, encodeKey: 'playback', toneMap: false });
    expect(read).toBeCloseTo(RATES.startSeconds + WORK.encodedFrames * (SOURCE_PIXELS / EDIT_DECODE[editTier] + OUTPUT_PIXELS / RATES.encodePixelsPerSecond), 6);
  });
});

describe('K05 the original as tool source decodes at its codec\'s key (design §5.4 估算 row, §10.11 容器)', () => {
  it('K05 a transparent ProRes 4444 original takes the ProRes key, not the alpha-layer or 12-bit key', async () => {
    expect((await decodeKey())({ codec: 'prores', bitDepth: 12, alpha: 'confirmed_alpha' }, SOURCE_RATES)).toBe('sdr_prores');
  });

  it('K05 a playback chunk read from the original decodes at the source key', () => {
    const stageKeys = fn<(stage: 'encode', source: { sourceDecodeKey: SourceKey; hdr: boolean; editTier: null }) => StageKeys>(plan, 'presentationStageKeys', '@shared/mini-tools/video-encode-plan.js');
    expect(stageKeys('encode', { sourceDecodeKey: 'sdr_prores', hdr: false, editTier: null })).toEqual({ decodeKey: 'sdr_prores', encodeKey: 'playback', toneMap: false });
    const seconds = estimate({ ...WORK, decodeKey: 'sdr_prores', encodeKey: 'playback', toneMap: false });
    expect(seconds).toBeCloseTo(RATES.startSeconds + WORK.encodedFrames * (SOURCE_PIXELS / SOURCE_RATES.sdr_prores + OUTPUT_PIXELS / RATES.encodePixelsPerSecond), 6);
  });
});

describe('E01 whether the original can be the tool source (design §4.2 源 table)', () => {
  const needs = async (): Promise<(facts: { variableFrameRate: boolean; transfer: string | null; seekable: boolean }) => boolean> =>
    fn(await frameGrid(), 'needsEditFile', '@shared/upload/frame-grid-rate.js');

  it.each([
    ['constant rate, SDR, seekable', { variableFrameRate: false, transfer: 'bt709', seekable: true }, false],
    ['constant rate, untagged transfer, seekable', { variableFrameRate: false, transfer: null, seekable: true }, false],
    ['variable frame rate', { variableFrameRate: true, transfer: 'bt709', seekable: true }, true],
    ['PQ', { variableFrameRate: false, transfer: 'smpte2084', seekable: true }, true],
    ['HLG', { variableFrameRate: false, transfer: 'arib-std-b67', seekable: true }, true],
    ['not seekable', { variableFrameRate: false, transfer: 'bt709', seekable: false }, true],
  ] as const)('E01 %s', async (_name, facts, expected) => {
    expect((await needs())(facts)).toBe(expected);
  });
});

describe('E02 the whole route over the deadline is too_long (design §5.4 上限 row)', () => {
  const failure = (): ((input: { remainingSeconds: number; chunkShare: number; maxParallelChunks: number; stages: RouteStage[] }) => 'too_long' | null) =>
    fn(plan, 'presentationRouteFailure', '@shared/mini-tools/video-encode-plan.js');
  const R = 7200;
  const budget = { remainingSeconds: R, chunkShare: 0.5, maxParallelChunks: 8 };

  it('E02 every stage fits: no failure', () => {
    const stages = [
      { stage: 'count', chunked: false, jobSeconds: [0.1 * R] },
      { stage: 'encode', chunked: true, jobSeconds: Array.from({ length: 8 }, () => 0.2 * R) },
      { stage: 'stitch', chunked: false, jobSeconds: [0.1 * R] },
    ];
    expect(failure()({ ...budget, stages })).toBeNull();
  });

  it('E02 each job fits its share but the stages in sequence pass the deadline: too_long', () => {
    // Eight parallel chunks of 0.3R take 0.3R under any folding by the parallel cap of 8; 0.45R + 0.3R + 0.3R > R.
    const stages = [
      { stage: 'count', chunked: false, jobSeconds: [0.45 * R] },
      { stage: 'encode', chunked: true, jobSeconds: Array.from({ length: 8 }, () => 0.3 * R) },
      { stage: 'stitch', chunked: false, jobSeconds: [0.3 * R] },
    ];
    expect(failure()({ ...budget, stages })).toBe('too_long');
  });

  it('E02 a job that cannot be chunked (the count) over one share: too_long', () => {
    const stages = [{ stage: 'count', chunked: false, jobSeconds: [0.51 * R] }, { stage: 'encode', chunked: true, jobSeconds: [0.01 * R] }];
    expect(failure()({ ...budget, stages })).toBe('too_long');
  });

  it('E02 more chunks in a stage than the parallel cap: too_long', () => {
    const stages = [{ stage: 'edit', chunked: true, jobSeconds: Array.from({ length: 9 }, () => 0.01 * R) }];
    expect(failure()({ ...budget, stages })).toBe('too_long');
  });
});
