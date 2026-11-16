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
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000, sdr_16bit: 294000000, hdr_16bit: 71900000 }, aacEncodeSecondsPerSecond: 100 },
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
  colorMatrixTagged: true, codec: 'h264', copyPreservesTimeline: true, audioCopyable: true, sourceBytes: 4096 };
const WORK = { encodedFrames: 1, prerollFrames: 0, sourceWidth: 2, sourceHeight: 2, outputWidth: 2, outputHeight: 2, bitDepth: 8, hdr: false, audioSeconds: 0 };
const PLANNED = { kind: 'planned', toolInputId: 'b'.repeat(64), planSha256: 'c'.repeat(64), plan: PLAN, encoding: { keyframeOrdinals: [0], codedWidth: 2, codedHeight: 2, sourceKeyframes: [{ pts: { numerator: '0', denominator: '1' }, dts: { numerator: '0', denominator: '1' } }], firstPacketDts: { numerator: '0', denominator: '1' } }, routeInput: ROUTE, work: WORK };

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

// S6d D2 (inner#1306 test plan §91): the ledger and carrier actions over the same contract. Both restart from the source,
// so they carry the probe's frozen facts again, plus the capability token the edge write handlers authorize with.
type FullPort = Port & {
  writeLedger: (capability: Record<string, unknown>, toolInputId: string, encodeFacts: unknown) => Promise<void>;
  carrier: (capability: Record<string, unknown>, route: 'identity' | 'copy') => Promise<unknown>;
};
const FACTS = { keyframeOrdinals: [0], codedWidth: 2, codedHeight: 2, sourceKeyframes: [{ pts: { numerator: '0', denominator: '1' }, dts: { numerator: '0', denominator: '1' } }], firstPacketDts: { numerator: '0', denominator: '1' } };
const RECEIPTS = [{ role: 'carrier', packing: 'native', storageKey: ADMISSION.storageKey, sha256: 'a'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4' }];
const COMMON = {
  jobId: ADMISSION.jobId, sourceFingerprint: ADMISSION.sourceFingerprint, deadlineAt: ADMISSION.deadlineAt, token: CAPABILITY.token, storageKey: ADMISSION.storageKey,
  sourceURL: SOURCE_URL, limits: LIMITS, encoding: ENCODING, probe: ADMISSION.probe,
};

describe('writeLedger through the run contract (§91 D2; design §5.1 step 5)', () => {
  it('PW01 sends one ledger request for the toolInputId with the probe encode facts and the capability token', async () => {
    const send = vi.fn<Send>(async () => ({ kind: 'written' }));
    await expect((port(send) as FullPort).writeLedger(CAPABILITY, 'b'.repeat(64), FACTS)).resolves.toBeUndefined();
    expect(send.mock.calls).toEqual([[{ action: 'ledger', ...COMMON, toolInputId: 'b'.repeat(64), encodeFacts: FACTS }]]);
  });

  it('PW02 a ledger-only repair sends no encode facts, so the container derives them again', async () => {
    const send = vi.fn<Send>(async () => ({ kind: 'written' }));
    await (port(send) as FullPort).writeLedger(CAPABILITY, 'b'.repeat(64), null);
    expect(send.mock.calls[0]![0]).toMatchObject({ action: 'ledger', encodeFacts: null });
  });

  it('PW03 a failed write rejects with the container code, and a malformed answer is a container fault', async () => {
    await expect((port(async () => ({ kind: 'failed', code: 'source_ledger_invalid' })) as FullPort).writeLedger(CAPABILITY, 'b'.repeat(64), FACTS))
      .rejects.toMatchObject({ code: 'source_ledger_invalid' });
    await expect((port(async () => ({ kind: 'done' })) as FullPort).writeLedger(CAPABILITY, 'b'.repeat(64), FACTS)).rejects.toThrow();
  });
});

describe('carrier through the run contract (§91 D2, D2-1; design §5.1 steps 3–4)', () => {
  it.each(['identity', 'copy'] as const)('PC01 a %s carrier sends one carrier request and hands back the written receipts for the store to measure', async (route) => {
    const send = vi.fn<Send>(async () => ({ kind: 'carrier', receipts: RECEIPTS }));
    expect(await (port(send) as FullPort).carrier(CAPABILITY, route)).toEqual({ kind: 'written', receipts: RECEIPTS });
    // §91 D2-7: the registered content type travels with the carrier request.
    expect(send.mock.calls).toEqual([[{ action: 'carrier', ...COMMON, route, contentType: ADMISSION.contentType }]]);
  });

  it('PC02 passes a failed carrier through with its code and rejects a malformed answer', async () => {
    expect(await (port(async () => ({ kind: 'failed', code: 'source_missing' })) as FullPort).carrier(CAPABILITY, 'copy')).toEqual({ kind: 'failed', code: 'source_missing' });
    await expect((port(async () => ({ kind: 'carrier', receipts: [] })) as FullPort).carrier(CAPABILITY, 'copy')).rejects.toThrow();
  });
});
