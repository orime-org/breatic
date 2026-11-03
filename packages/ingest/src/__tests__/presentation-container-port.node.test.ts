// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6d D1: the presentation DO's basic-container port over the run contract (inner#1306 test plan §91 D-3; design §5.1
 * step 2). The port that `preparePresentation` drives (`PresentationContainerPort`) sends a probe request built only
 * from the job's frozen admission and capability, and maps the container's answer onto the store's `PresentationProbe`:
 * display from the plan's display, playback clock from the plan's presentation table. A malformed answer is a
 * container fault, not a plan. The transport (container fetch through the outbound source handler) is injected.
 */
import { describe, expect, it, vi } from 'vitest';
import * as portOwner from '@ingest/presentation-container-port.js';

type Send = (body: Record<string, unknown>) => Promise<unknown>;
interface Port { probe: (capability: Record<string, unknown>) => Promise<unknown> }

const r = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
const LIMITS = {
  maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536,
  sourceLedger: { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 },
};
const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 163000000, decodeConvertPixelsPerSecond: { sdr_8bit: 1950000000, sdr_10bit: 705000000, sdr_12bit: 1430000000, hdr_8bit: 152000000, hdr_10bit: 103000000, hdr_12bit: 116000000 } },
  copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const ADMISSION = {
  storageKey: 'video/canonical.mp4', sourceFingerprint: 'a'.repeat(64), jobId: 'video-presentation-a', deadlineAt: 1900000000000, contentType: 'video/mp4', original: null,
  limits: LIMITS, encoding: ENCODING, probe: { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }] }, targetPolicyVersion: 1,
};
const CAPABILITY = { storageKey: ADMISSION.storageKey, sourceFingerprint: ADMISSION.sourceFingerprint, jobId: ADMISSION.jobId, deadlineAt: ADMISSION.deadlineAt, token: 'token-a' };
const SOURCE_URL = 'http://source.local/video/canonical.mp4';
const PLAN = {
  display: { width: 2, height: 2, duration: r(1) }, colorMatrix: 'bt709', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 },
  policy: { singleFrameDurationMs: 5000, emptyFill: 'black' }, presentation: { schemaVersion: 1, timescale: 1, runs: [{ start: 0, count: 1, step: 1, duration: 1 }] },
  originMapping: { timeBase: r(1), origin: r(0), entries: [{ kind: 'source', start: 0, count: 1, step: 0 }],
    firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(1), hold: null } },
  videoSpans: null, audioSpans: null, segmentDuration: null,
};
const ROUTE = { plan: { planSha256: 'c'.repeat(64), producerVersion: 2, profileVersion: 1 }, hdr: false, alpha: 'confirmed_opaque', identityQualified: true,
  colorMatrixTagged: true, codec: 'h264', copyPreservesTimeline: true, sourceBytes: 4096 };
const WORK = { encodedFrames: 1, prerollFrames: 0, sourceWidth: 2, sourceHeight: 2, outputWidth: 2, outputHeight: 2, bitDepth: 8, hdr: false };
const PLANNED = { kind: 'planned', toolInputId: 'b'.repeat(64), planSha256: 'c'.repeat(64), plan: PLAN, encoding: { keyframeOrdinals: [0], codedWidth: 2, codedHeight: 2 }, routeInput: ROUTE, work: WORK };

/**
 * The port under test, read at call time.
 * @param send - The injected transport.
 * @returns The port.
 */
function port(send: Send): Port {
  const create = (portOwner as Record<string, unknown>).createPresentationContainerPort;
  expect(create, 'createPresentationContainerPort is exported from @ingest/presentation-container-port.js').toBeTypeOf('function');
  return (create as (send: Send, admission: unknown, sourceURL: string) => Port)(send, ADMISSION, SOURCE_URL);
}

describe('probe through the run contract (§91 D-3)', () => {
  it('PO01 sends one probe request built from the capability and the frozen admission, with no token and no earlier disk', async () => {
    const send = vi.fn<Send>(async () => PLANNED);
    await port(send).probe(CAPABILITY);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({
      action: 'probe', jobId: ADMISSION.jobId, sourceFingerprint: ADMISSION.sourceFingerprint, deadlineAt: ADMISSION.deadlineAt, sourceURL: SOURCE_URL,
      limits: LIMITS, encoding: ENCODING, probe: ADMISSION.probe,
    });
  });

  it('PO02 maps a planned answer onto the store probe: display and playback clock come from the plan', async () => {
    expect(await port(async () => PLANNED).probe(CAPABILITY)).toEqual({
      kind: 'planned', toolInputId: PLANNED.toolInputId, planSha256: PLANNED.planSha256, routeInput: ROUTE, encoding: PLANNED.encoding, work: WORK,
      display: PLAN.display, playbackClock: PLAN.presentation,
    });
  });

  it('PO03 passes a failed answer through with its code', async () => {
    expect(await port(async () => ({ kind: 'failed', code: 'classification_unknown' })).probe(CAPABILITY)).toEqual({ kind: 'failed', code: 'classification_unknown' });
  });

  it.each([
    ['a plan that breaks an invariant', { ...PLANNED, plan: { ...PLAN, display: { ...PLAN.display, duration: r(3) } } }],
    ['no work', { ...PLANNED, work: undefined }],
    ['not an object', 'ok'],
  ])('PO04 rejects %s as a container fault instead of planning on it', async (_name, answer) => {
    await expect(port(async () => answer).probe(CAPABILITY)).rejects.toThrow();
  });
});
