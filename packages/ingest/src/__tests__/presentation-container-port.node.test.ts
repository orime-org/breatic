// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The presentation DO's basic-container port over the probe contract (inner#1306; frames-split design §5.1 step 2). The port
 * that `preparePresentation` drives (`PresentationContainerPort`) sends a probe request built only from the job's frozen
 * admission and capability, and hands the container's parsed answer to the store. A malformed answer, or one whose plan
 * digest is not its plan's, is a container fault, not a plan. The transport is injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPresentationContainerPort } from '@ingest/presentation-container-port.js';
import { videoPresentationPlanSha256 } from '@shared/upload/video-presentation-version.js';

type Send = (body: Record<string, unknown>) => Promise<unknown>;

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
const ADMISSION = {
  storageKey: 'video/canonical.mp4', sourceFingerprint: 'a'.repeat(64), jobId: 'video-presentation-a', deadlineAt: 1900000000000, contentType: 'video/mp4', original: null,
  limits: LIMITS, encoding: ENCODING, probe: PROBE_FACTS, targetPolicyVersion: 1,
};
const CAPABILITY = { storageKey: ADMISSION.storageKey, sourceFingerprint: ADMISSION.sourceFingerprint, jobId: ADMISSION.jobId, deadlineAt: ADMISSION.deadlineAt, token: 'token-a' };
const SOURCE_URL = 'http://source.local/video/canonical.mp4';

/**
 * The planned answer with its plan's own digest.
 * @returns It.
 */
async function planned(): Promise<Record<string, unknown>> {
  return { ...PLANNED_FIELDS, planSha256: await videoPresentationPlanSha256(PLAN) };
}

/**
 * The port under test over an injected transport.
 * @param send - The transport.
 * @returns The port.
 */
function port(send: Send): ReturnType<typeof createPresentationContainerPort> {
  return createPresentationContainerPort(send, ADMISSION as never, SOURCE_URL);
}

describe('probe through the contract (§5.1 step 2)', () => {
  it('PO01 sends one probe request built from the capability and the frozen admission, with no token and no earlier disk', async () => {
    const answer = await planned();
    const send = vi.fn<Send>(async () => answer);
    await port(send).probe(CAPABILITY);
    expect(send.mock.calls).toEqual([[{
      action: 'probe', jobId: ADMISSION.jobId, sourceFingerprint: ADMISSION.sourceFingerprint, deadlineAt: ADMISSION.deadlineAt, sourceURL: SOURCE_URL,
      limits: LIMITS, encoding: ENCODING, probe: PROBE_FACTS,
    }]]);
  });

  it('PO02 hands a planned answer to the store as the container answered it', async () => {
    const answer = await planned();
    expect(await port(async () => answer).probe(CAPABILITY)).toEqual(answer);
  });

  it('PO03 passes a failed answer through with its code', async () => {
    expect(await port(async () => ({ kind: 'failed', code: 'classification_unknown' })).probe(CAPABILITY)).toEqual({ kind: 'failed', code: 'classification_unknown' });
  });

  it.each([
    ['a digest of another plan', async (): Promise<unknown> => ({ ...await planned(), planSha256: 'd'.repeat(64) })],
    ['a plan the shared schema refuses', async (): Promise<unknown> => ({ ...await planned(), plan: { ...PLAN, gridRulesVersion: 0 } })],
    ['no tool-source facts', async (): Promise<unknown> => ({ ...await planned(), source: undefined })],
    ['not an object', async (): Promise<unknown> => 'ok'],
  ])('PO04 rejects %s as a container fault instead of planning on it', async (_name, answer) => {
    const body = await answer();
    await expect(port(async () => body).probe(CAPABILITY)).rejects.toThrow();
  });

  it('PO05 refuses a capability of another job before sending anything', async () => {
    const send = vi.fn<Send>(async () => planned());
    await expect(port(send).probe({ ...CAPABILITY, jobId: 'video-presentation-b' })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the probe\'s measured usage (§7.6 F row: the basic execution\'s real wall time is a platform expense)', () => {
  it('PO06 reports nothing before the probe and the probe\'s own wall time after it, with CPU time unknown', async () => {
    const answer = await planned();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1_000);
    const measured = port(async () => { clock.mockReturnValue(4_250); return answer; });
    expect(await measured.usage()).toBe(null);
    await measured.probe(CAPABILITY);
    expect(await measured.usage()).toEqual({ wallMs: 3_250, cpuUsec: null });
    clock.mockRestore();
  });

  it('PO07 a probe the container answered as failed still ran, and its wall time is reported', async () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1_000);
    const measured = port(async () => { clock.mockReturnValue(1_400); return { kind: 'failed', code: 'classification_unknown' }; });
    await measured.probe(CAPABILITY);
    expect(await measured.usage()).toEqual({ wallMs: 400, cpuUsec: null });
    clock.mockRestore();
  });
});
