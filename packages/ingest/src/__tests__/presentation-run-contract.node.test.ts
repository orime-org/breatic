// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6d D1: the presentation run contract between the basic presentation DO and its container (inner#1306 test plan
 * §91 D-3; frames-split design §5.1 step 2).
 *
 * One contract file, one path, three actions (probe, ledger, carrier); each action restarts from the source, so a
 * request names the source and every frozen fact it needs and never refers to an earlier call's disk. D1 covers the
 * probe action and its answer; the ledger and carrier bodies arrive with D2. The answer carries the plan (checked by
 * the shared plan schema), its identities, the full ledger's encode facts, the route facts and the job work.
 */
import { describe, expect, it } from 'vitest';
import * as contractOwner from '@ingest/presentation-run-contract.js';

interface Schema { safeParse: (value: unknown) => { success: boolean } }

/**
 * One export of the contract, read at call time.
 * @param name - The export.
 * @returns It.
 */
function exported<T>(name: string): T {
  const value = (contractOwner as Record<string, unknown>)[name];
  expect(value, `${name} is exported from @ingest/presentation-run-contract.js`).toBeDefined();
  return value as T;
}

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
const PROBE = {
  action: 'probe', jobId: 'video-presentation-a', sourceFingerprint: 'a'.repeat(64), deadlineAt: 1900000000000,
  sourceURL: 'http://source.local/video/canonical.mp4', limits: LIMITS, encoding: ENCODING, probe: { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }] },
};
// A one-frame plan the shared plan schema accepts (checked against the §7.16 invariants).
const PLAN = {
  display: { width: 2, height: 2, duration: r(1) }, colorMatrix: 'bt709', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 },
  policy: { singleFrameDurationMs: 5000, emptyFill: 'black' }, presentation: { schemaVersion: 1, timescale: 1, runs: [{ start: 0, count: 1, step: 1, duration: 1 }] },
  originMapping: { timeBase: r(1), origin: r(0), entries: [{ kind: 'source', start: 0, count: 1, step: 0 }],
    firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(1), hold: null } },
  videoSpans: null, audioSpans: null, segmentDuration: null,
};
const PLANNED = {
  kind: 'planned', toolInputId: 'b'.repeat(64), planSha256: 'c'.repeat(64), plan: PLAN,
  encoding: { keyframeOrdinals: [0], codedWidth: 2, codedHeight: 2, sourceKeyframes: [{ pts: { numerator: '0', denominator: '1' }, dts: { numerator: '0', denominator: '1' } }], firstPacketDts: { numerator: '0', denominator: '1' } },
  routeInput: { plan: { planSha256: 'c'.repeat(64), producerVersion: 2, profileVersion: 1 }, hdr: false, alpha: 'confirmed_opaque', identityQualified: true,
    colorMatrixTagged: true, codec: 'h264', copyPreservesTimeline: true, audioCopyable: true, sourceBytes: 4096 },
  work: { encodedFrames: 1, prerollFrames: 0, sourceWidth: 2, sourceHeight: 2, outputWidth: 2, outputHeight: 2, bitDepth: 8, hdr: false, audioSeconds: 0 },
};

describe('the one path (§91 D-3)', () => {
  it('CR01 names one path for all three actions', () => {
    expect(exported<string>('PRESENTATION_RUN_PATH')).toBe('/presentation');
  });
});

describe('the probe request (§91 D-3, D-6)', () => {
  const parse = (value: unknown): boolean => exported<Schema>('presentationRunRequestSchema').safeParse(value).success;

  it('CR02 accepts a probe that names the source and every frozen fact it needs', () => {
    expect(parse(PROBE)).toBe(true);
  });

  it.each([
    ['no sample count', { probe: { singleFrameDurationMs: 5000, identityFormats: PROBE.probe.identityFormats } }],
    ['a zero sample count', { probe: { ...PROBE.probe, sampleFrames: 0 } }],
    ['a fractional sample count', { probe: { ...PROBE.probe, sampleFrames: 1.5 } }],
    ['no single-frame duration', { probe: { sampleFrames: 1, identityFormats: PROBE.probe.identityFormats } }],
    ['no identity table', { probe: { sampleFrames: 1, singleFrameDurationMs: 5000 } }],
    ['no source URL', { sourceURL: undefined }],
    ['no source ledger budgets', { limits: { ...LIMITS, sourceLedger: undefined } }],
    ['no frozen encoding', { encoding: undefined }],
    ['a malformed fingerprint', { sourceFingerprint: 'not-a-hash' }],
    ['a field from an earlier call', { probeDirectory: '/tmp/presentation-a' }],
    ['an unknown action', { action: 'alpha' }],
  ])('CR03 refuses a probe with %s', (_name, change) => {
    expect(parse(PROBE)).toBe(true);
    expect(parse({ ...PROBE, ...change })).toBe(false);
  });
});

describe('the probe answer (§91 D-3; design §5.1 step 2)', () => {
  const parse = (value: unknown): boolean => exported<Schema>('presentationProbeAnswerSchema').safeParse(value).success;

  it('CR04 accepts a planned answer and a failed answer with a stable code', () => {
    expect(parse(PLANNED)).toBe(true);
    expect(parse({ kind: 'failed', code: 'classification_unknown' })).toBe(true);
    // §91 D1-3: 12-bit sources (ProRes 4444) have measured rates, so their work carries depth 12.
    expect(parse({ ...PLANNED, work: { ...PLANNED.work, bitDepth: 12 } })).toBe(true);
    expect(parse({ ...PLANNED, work: { ...PLANNED.work, bitDepth: 16 } })).toBe(true);
  });

  it.each([
    ['a plan that breaks a §7.16 invariant', { plan: { ...PLAN, display: { ...PLAN.display, duration: r(2) } } }],
    ['a malformed toolInputId', { toolInputId: 'x' }],
    ['no encode facts', { encoding: undefined }],
    ['an unknown alpha class', { routeInput: { ...PLANNED.routeInput, alpha: 'unknown' } }],
    ['a 14-bit work depth', { work: { ...PLANNED.work, bitDepth: 14 } }],
    ['a route plan of another plan', { routeInput: { ...PLANNED.routeInput, plan: { ...PLANNED.routeInput.plan, planSha256: 'd'.repeat(64) } } }],
  ])('CR05 refuses a planned answer with %s', (_name, change) => {
    expect(parse(PLANNED)).toBe(true);
    expect(parse({ ...PLANNED, ...change })).toBe(false);
  });

  it('CR05 refuses a failed answer with a malformed code', () => {
    expect(parse({ kind: 'failed', code: 'Not Stable' })).toBe(false);
  });
});

// S6d D2 (inner#1306 test plan §91; design §5.1 steps 3–5, §3.2 item 7): the ledger and carrier actions. Each restarts
// from the source (§91 D-3), so both carry the probe's frozen facts to plan again, plus the capability token the edge
// handlers authorize writes with and the canonical storage key the written keys derive from.
const capabilityFields = { jobId: PROBE.jobId, sourceFingerprint: PROBE.sourceFingerprint, deadlineAt: PROBE.deadlineAt, token: 'token-a', storageKey: 'video/canonical.mp4',
  sourceURL: PROBE.sourceURL, limits: LIMITS, encoding: ENCODING, probe: PROBE.probe };
const LEDGER = { action: 'ledger', ...capabilityFields, toolInputId: 'b'.repeat(64), encodeFacts: { keyframeOrdinals: [0, 10], codedWidth: 320, codedHeight: 180,
  sourceKeyframes: [{ pts: { numerator: '0', denominator: '1' }, dts: { numerator: '0', denominator: '1' } }, { pts: { numerator: '2', denominator: '5' }, dts: { numerator: '2', denominator: '5' } }], firstPacketDts: { numerator: '0', denominator: '1' } } };
// §91 D2-7: the carrier request carries the registered content type, which the identity receipt takes.
const CARRIER = { action: 'carrier', ...capabilityFields, route: 'copy', contentType: 'video/mp4' };
const RECEIPT = { role: 'carrier', packing: 'native', storageKey: 'video/canonical.mp4.video-presentation:video-presentation-a:copy:a1', sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4' };

describe('the ledger action (§91 D2; design §5.1 step 5, §3.2 item 7)', () => {
  const parseRequest = (value: unknown): boolean => exported<Schema>('presentationRunRequestSchema').safeParse(value).success;
  const parseAnswer = (value: unknown): boolean => exported<Schema>('presentationLedgerAnswerSchema').safeParse(value).success;

  it('LR01 accepts a ledger write for one toolInputId with its encode facts, and a ledger-only repair without them', () => {
    expect(parseRequest(LEDGER)).toBe(true);
    expect(parseRequest({ ...LEDGER, encodeFacts: null })).toBe(true);
  });

  it.each([
    ['no token', { token: undefined }], ['no storage key', { storageKey: undefined }], ['a malformed toolInputId', { toolInputId: 'x' }],
    ['encode facts without keyframes', { encodeFacts: { codedWidth: 320, codedHeight: 180 } }], ['no probe facts', { probe: undefined }],
    ['a field from an earlier call', { plan: {} }],
  ])('LR02 refuses a ledger write with %s', (_name, change) => {
    const value: Record<string, unknown> = { ...LEDGER, ...change };
    for (const [field, entry] of Object.entries(change)) if (entry === undefined) delete value[field];
    expect(parseRequest(LEDGER)).toBe(true);
    expect(parseRequest(value)).toBe(false);
  });

  it('LR03 answers written or a failure with a stable code', () => {
    expect(parseAnswer({ kind: 'written' })).toBe(true);
    expect(parseAnswer({ kind: 'failed', code: 'source_ledger_invalid' })).toBe(true);
    expect(parseAnswer({ kind: 'failed', code: 'Not Stable' })).toBe(false);
    expect(parseAnswer({ kind: 'written', receipt: {} })).toBe(false);
  });
});

describe('the carrier action (§91 D2; design §5.1 steps 3–4, §4.1)', () => {
  const parseRequest = (value: unknown): boolean => exported<Schema>('presentationRunRequestSchema').safeParse(value).success;
  const parseAnswer = (value: unknown): boolean => exported<Schema>('presentationCarrierAnswerSchema').safeParse(value).success;

  it('CA01 accepts a carrier request for the identity and the basic copy routes only', () => {
    expect(parseRequest(CARRIER)).toBe(true);
    expect(parseRequest({ ...CARRIER, route: 'identity' })).toBe(true);
    for (const route of ['dispatch_copy', 'encode', 'reuse']) expect(parseRequest({ ...CARRIER, route })).toBe(false);
  });

  it('CA02 refuses a carrier request without its token or its registered content type', () => {
    const { token: _dropped, ...value } = CARRIER;
    expect(parseRequest(value)).toBe(false);
    const { contentType: _type, ...untyped } = CARRIER;
    expect(parseRequest(CARRIER)).toBe(true);
    expect(parseRequest(untyped)).toBe(false);
  });

  it('CA03 answers the role-tagged receipts of the carrier, or a failure', () => {
    expect(parseAnswer({ kind: 'carrier', receipts: [RECEIPT] })).toBe(true);
    expect(parseAnswer({ kind: 'failed', code: 'source_missing' })).toBe(true);
    expect(parseAnswer({ kind: 'carrier', receipts: [] })).toBe(false);
    expect(parseAnswer({ kind: 'carrier', receipts: [{ ...RECEIPT, role: 'manifest' }] })).toBe(false);
    expect(parseAnswer({ kind: 'carrier', bundle: {} })).toBe(false);
  });
});
