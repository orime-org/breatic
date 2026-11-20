// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation probe contract between the basic presentation DO and its container (inner#1306; frames-split design §5.1
 * step 2, §3.2, §4.1, §4.2).
 *
 * One path and one action: the probe restarts from the source, so a request names the source and every frozen fact it needs
 * and never refers to an earlier call's disk. The answer carries the plan (checked by the shared plan schema), its digest,
 * the sha256 producer, playback and edit profile versions, the tool-source facts and the grid inputs; an edit tier, an
 * edit-file plan and an edit profile version go together.
 */
import { describe, expect, it } from 'vitest';
import { PRESENTATION_RUN_PATH, presentationProbeAnswerSchema, presentationRunRequestSchema } from '@ingest/presentation-run-contract.js';

const LIMITS = { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: {
    startSeconds: 3, encodePixelsPerSecond: 248e6, tonemapPixelsPerSecond: 1170e6,
    decodeConvertPixelsPerSecond: {
      sdr_8bit: 910e6, sdr_10bit: 810e6, sdr_12bit: 690e6, sdr_alpha_layer: 600e6, sdr_prores: 820e6, sdr_dnx: 735e6, sdr_av1_8bit: 740e6, sdr_av1_10bit: 570e6,
      sdr_av1_12bit: 610e6, sdr_jpeg2000: 25e6, sdr_ffv1: 75e6, sdr_png: 340e6, sdr_other: 1080e6,
      edit_h264_intra_8bit_420: 1500e6, edit_h264_intra_10bit_420: 1200e6, edit_h264_intra_8bit_444: 1100e6, edit_h264_intra_10bit_444: 900e6, edit_prores: 950e6,
    },
    editEncodePixelsPerSecond: { edit_h264_intra_8bit_420: 300e6, edit_h264_intra_10bit_420: 250e6, edit_h264_intra_8bit_444: 200e6, edit_h264_intra_10bit_444: 180e6, edit_prores: 400e6 },
    aacEncodeSecondsPerSecond: 100,
  },
  edit: { crf: 15, preset: 'medium', proresProfile: '4444', bytesPerPixel: 0.5, maxEditBytes: 10_000_000_000 },
  carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const PROBE_FACTS = { sampleFrames: 1, singleFrameDurationMs: 5000, maxFps: 120 };
const FPS = { numerator: 25, denominator: 1 };
const ZERO = { numerator: 0, denominator: 1 };
// A one-second 25 fps plan the shared plan schema accepts (§3.2 item 2).
const PLAN = {
  gridRulesVersion: 1, grid: { fps: FPS, gridStart: ZERO, leadFrames: 0, gridEnd: null, singleFrameDurationMs: 5000 }, toolSource: 'original', audioTrack: null,
  display: { width: 2, height: 2 }, color: { matrix: 'bt709', toneMap: 'none' }, framePngBitDepth: 8,
};
const SOURCE = {
  sourceDecodeKey: 'sdr_8bit', keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false }, hdr: false, alpha: false, editTier: null, seekable: true, bitDepth: 8,
  color: { matrix: 'bt709', transfer: 'bt709', primaries: 'bt709', range: 'tv', chromaLocation: 'left' },
};
const PLANNED_FIELDS = {
  kind: 'planned', plan: PLAN, versions: { producerVersion: '1'.repeat(64), profileVersion: '2'.repeat(64), editProfileVersion: null }, source: SOURCE,
  gridInput: { fps: FPS, firstVideoTime: ZERO, firstAudioFrameTime: null, audioEnd: null, quantum: ZERO },
  estimate: { lastVideoTime: { numerator: 24, denominator: 25 }, sourceFrames: 25, frameCount: 25, realFrameCount: 25 }, sourceBytes: 4096,
};
const PROBE = {
  action: 'probe', jobId: 'video-presentation-a', sourceFingerprint: 'a'.repeat(64), deadlineAt: 1900000000000,
  sourceURL: 'http://source.local/video/canonical.mp4', limits: LIMITS, encoding: ENCODING, probe: PROBE_FACTS,
};
const PLANNED = { ...PLANNED_FIELDS, planSha256: 'c'.repeat(64) };
const EDIT = { plan: { ...PLAN, toolSource: 'edit' }, source: { ...SOURCE, editTier: 'edit_h264_intra_8bit_420' }, versions: { ...PLANNED.versions, editProfileVersion: '3'.repeat(64) } };

describe('the one path', () => {
  it('CR01 names one path for the probe', () => {
    expect(PRESENTATION_RUN_PATH).toBe('/presentation');
  });
});

describe('the probe request (§5.1 step 2)', () => {
  const parse = (value: unknown): boolean => presentationRunRequestSchema.safeParse(value).success;

  it('CR02 accepts a probe that names the source and every frozen fact it needs', () => {
    expect(parse(PROBE)).toBe(true);
  });

  it.each([
    ['no sample count', { probe: { singleFrameDurationMs: 5000, maxFps: 120 } }],
    ['a zero sample count', { probe: { ...PROBE_FACTS, sampleFrames: 0 } }],
    ['a fractional sample count', { probe: { ...PROBE_FACTS, sampleFrames: 1.5 } }],
    ['no single-frame duration', { probe: { sampleFrames: 1, maxFps: 120 } }],
    ['no rate cap', { probe: { sampleFrames: 1, singleFrameDurationMs: 5000 } }],
    ['no source URL', { sourceURL: undefined }],
    ['no frozen encoding', { encoding: undefined }],
    ['a malformed fingerprint', { sourceFingerprint: 'not-a-hash' }],
    ['a field from an earlier call', { probeDirectory: '/tmp/presentation-a' }],
    ['an unknown action', { action: 'ledger' }],
  ])('CR03 refuses a probe with %s', (_name, change) => {
    expect(parse(PROBE)).toBe(true);
    expect(parse({ ...PROBE, ...change })).toBe(false);
  });
});

describe('the probe answer (§5.1 step 2, §3.2, §4.2)', () => {
  const parse = (value: unknown): boolean => presentationProbeAnswerSchema.safeParse(value).success;

  it('CR04 accepts a planned answer, one through an edit file, and a failed answer with a stable code', () => {
    expect(parse(PLANNED)).toBe(true);
    expect(parse({ ...PLANNED, ...EDIT })).toBe(true);
    expect(parse({ kind: 'failed', code: 'classification_unknown' })).toBe(true);
  });

  it.each([
    ['a plan the shared schema refuses', { plan: { ...PLAN, gridRulesVersion: 0 } }],
    ['a malformed plan digest', { planSha256: 'x' }],
    ['an integer producer version', { versions: { ...PLANNED.versions, producerVersion: 2 } }],
    ['a decode key outside the closed table', { source: { ...SOURCE, sourceDecodeKey: 'hdr_10bit' } }],
    ['an edit tier on an original-source plan', { source: { ...SOURCE, editTier: 'edit_h264_intra_8bit_420' }, versions: EDIT.versions }],
    ['an edit-file plan without its tier', { plan: EDIT.plan }],
    ['an edit tier without an edit profile version', { plan: EDIT.plan, source: EDIT.source }],
    ['no grid estimate', { estimate: undefined }],
  ])('CR05 refuses a planned answer with %s', (_name, change) => {
    expect(parse(PLANNED)).toBe(true);
    expect(parse({ ...PLANNED, ...change })).toBe(false);
  });

  it('CR06 refuses a failed answer with a malformed code', () => {
    expect(parse({ kind: 'failed', code: 'Not Stable' })).toBe(false);
  });
});
