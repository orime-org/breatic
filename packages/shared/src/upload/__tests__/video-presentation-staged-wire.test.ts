// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The staged presentation wire between the worker and ingest (inner#1306 test
 * plan §90 E2; frames-split design §5.1 steps 1, 2 and 2a, §5.4, §7.1, §7.1.1,
 * §7.17; interface choices E2-1 to E2-5).
 *
 * E2-1: the accept freezes an `encoding` sibling (chunk share, parallel cap, the
 * S6b encoder rates, the copy disk margin, the carrier short side and colour).
 * E2-3/E2-4: `prepare` replaces `run`; `fail` absorbs `expire`; the follow-up
 * actions carry the capability (identity, D and token). The worker-only prepare
 * answer is the snapshot plus capability, plan, work, the candidate's own L, the
 * job's unit set and the frozen pricing and attribution. E2-5: one key function
 * names a sub-job's output from its job id; the outer recipe shapes are frozen
 * here and the clip entries are S6d's.
 */

import { describe, expect, it } from 'vitest';
import * as shared from '../../index.js';
import { videoPresentationIngestRequestSchema } from '../video-presentation-ingest.js';
import { miniToolPlanJobReportSchema, miniToolPlanJobRequestSchema, miniToolPlanRecipeSchema } from '../mini-tool-plan-job.js';
import { videoContainerJobId } from '../../mini-tools/video-encode-plan.js';
import type { MiniToolPlanRecipe } from '../mini-tool-plan-types.js';
import { videoPresentationKeyFor } from '../video-presentation.js';
import { videoSourceLedgerKeyFor } from '../video-source-ledger.js';

const H = 'a'.repeat(64);
const T = 'c'.repeat(64);
const PLAN = 'd'.repeat(64);
const KEY = 'video/canonical.webm';
const D = 1900000000000;
const INPUT = '5d0c8e3a-6a8c-4c21-9a2e-3b1f0f6c9b11';
const price = (containerClass: string, vcpu: number, memory: number, disk: number): Record<string, unknown> => ({
  containerClass, size: { vcpu, memory_gib: memory, disk_gb: disk }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 },
});
const PRICING = { basic: price('MediaContainer', 0.25, 1, 4), standard4: price('MiniToolContainerStd4', 4, 12, 20) };
const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000, sdr_16bit: 294000000, hdr_16bit: 71900000 }, aacEncodeSecondsPerSecond: 100 },
  copyDiskMarginBytes: 33554432,
  carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const accept = {
  action: 'accept', storageKey: KEY, sourceFingerprint: H, jobId: 'video-presentation-a', deadlineAt: D,
  original: null, contentType: 'video/webm',
  limits: { maxSourceBytes: 1, maxPackedBytes: 1, crf: 18, preset: 'medium', probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
  pricing: PRICING, targetPolicyVersion: 1, policy: { chunkRetries: 3, maxAutoRepairs: 3 }, encoding: ENCODING,
  // S6d D1 (§91 D-6): the probe's sample count and the plan's single-frame duration are frozen at admission.
  probe: { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }] },
  actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
  publicBaseURL: 'https://assets.example.test',
};
const identity = { storageKey: KEY, sourceFingerprint: H, jobId: 'video-presentation-a' };
const capability = { ...identity, deadlineAt: D, token: 'token-a' };

/**
 * The request schema's verdict.
 * @param value - A candidate request.
 * @returns Whether it parses.
 */
function admits(value: unknown): boolean {
  return videoPresentationIngestRequestSchema.safeParse(value).success;
}

/**
 * A main-entry export, read at call time so a missing one fails its own case.
 * @param name - The export.
 * @returns It.
 */
function exported<T>(name: string): T {
  const value = (shared as Record<string, unknown>)[name];
  expect(value, `${name} is exported from @breatic/shared`).toBeDefined();
  return value as T;
}

describe('E2-1 the accept freezes the encoding parameters (§3.2 item 1, §3.5 「轮询不热读配置」, §5.1 step 1)', () => {
  it('EN01 an accept with the encoding sibling parses unchanged', () => {
    expect(videoPresentationIngestRequestSchema.parse(accept)).toEqual(accept);
  });

  it.each([
    ['no encoding', undefined],
    ['a zero chunk share', { ...ENCODING, chunkShare: 0 }],
    ['a chunk share above the whole budget', { ...ENCODING, chunkShare: 1.5 }],
    ['a zero parallel cap', { ...ENCODING, maxParallelChunks: 0 }],
    ['a fractional parallel cap', { ...ENCODING, maxParallelChunks: 1.5 }],
    ['a zero encode rate', { ...ENCODING, encoder: { ...ENCODING.encoder, encodePixelsPerSecond: 0 } }],
    ['a missing HDR 10-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, sdr_12bit: 1, hdr_8bit: 1, hdr_12bit: 1, sdr_16bit: 1, hdr_16bit: 1 } } }],
    // S6d D1-3 (§91): the 12-bit rates are frozen with the others.
    ['a missing SDR 12-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, hdr_8bit: 1, hdr_10bit: 1, hdr_12bit: 1, sdr_16bit: 1, hdr_16bit: 1 } } }],
    ['a missing HDR 12-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, sdr_12bit: 1, hdr_8bit: 1, hdr_10bit: 1, sdr_16bit: 1, hdr_16bit: 1 } } }],
    // A 16-bit source (16 bpc PNG-in-MOV) has its own rates.
    ['a missing SDR 16-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, sdr_12bit: 1, hdr_8bit: 1, hdr_10bit: 1, hdr_12bit: 1, hdr_16bit: 1 } } }],
    ['a missing HDR 16-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, sdr_12bit: 1, hdr_8bit: 1, hdr_10bit: 1, hdr_12bit: 1, sdr_16bit: 1 } } }],
    ['a negative copy margin', { ...ENCODING, copyDiskMarginBytes: -1 }],
    ['a zero carrier short side', { ...ENCODING, carrier: { ...ENCODING.carrier, maxShortSide: 0 } }],
    ['an unknown key', { ...ENCODING, retries: 3 }],
  ])('EN02 rejects an accept with %s', (_name, encoding) => {
    expect(admits(accept)).toBe(true);
    const value: Record<string, unknown> = { ...accept, encoding };
    if (encoding === undefined) delete value.encoding;
    expect(admits(value)).toBe(false);
  });
});

// §93 D6 (frames-split design §3.5 server/worker→ingest row): a discovery read or dedup winner may make its accept conditional
// with `expect: 'first' | 'readmit'`, and the snapshot carries the DO's `readmit` fact.
describe('conditional accepts and the readmit fact on the wire (§93 D6; design §3.5)', () => {
  it.each(['first', 'readmit'])('CW10 an accept with expect %s is admitted', (condition) => {
    expect(admits({ ...accept, expect: condition })).toBe(true);
  });

  it.each(['always', null, true])('CW11 an accept with expect %j is refused', (condition) => {
    expect(admits({ ...accept, expect: condition })).toBe(false);
  });

  it.each([true, false])('CW12 a snapshot carrying readmit %s is admitted', (readmit) => {
    const schema = exported<{ safeParse: (value: unknown) => { success: boolean } }>('videoPresentationIngestSnapshotSchema');
    const snapshot = { sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, ledger: null, readmit,
      preparation: { targetPolicyVersion: 1, jobId: 'video-presentation-a', stage: 'publish', failure: readmit ? null : 'presentation_invalid' } };
    expect(schema.safeParse(snapshot).success).toBe(true);
  });
});

describe('S6d D1 frozen probe facts on the accept (inner#1306 §91 D-6; design §5.1 step 2, §4.2.1)', () => {
  it.each([
    ['no probe facts', { probe: undefined }],
    ['no sample count', { probe: { singleFrameDurationMs: 5000, identityFormats: accept.probe.identityFormats } }],
    ['a zero sample count', { probe: { ...accept.probe, sampleFrames: 0 } }],
    ['a fractional sample count', { probe: { ...accept.probe, sampleFrames: 1.5 } }],
    ['no single-frame duration', { probe: { sampleFrames: 1, identityFormats: accept.probe.identityFormats } }],
    ['a zero single-frame duration', { probe: { ...accept.probe, singleFrameDurationMs: 0 } }],
    ['an unknown probe field', { probe: { ...accept.probe, decodeAll: true } }],
    // §91 D1-1: the identity table travels with the frozen probe facts.
    ['no identity table', { probe: { sampleFrames: 1, singleFrameDurationMs: 5000 } }],
    ['an identity entry with a rotation', { probe: { ...accept.probe, identityFormats: [{ ...accept.probe.identityFormats[0]!, rotation: 90 }] } }],
    ['an identity entry with another SAR', { probe: { ...accept.probe, identityFormats: [{ ...accept.probe.identityFormats[0]!, sar: '2:1' }] } }],
    ['an identity entry for an untagged matrix', { probe: { ...accept.probe, identityFormats: [{ ...accept.probe.identityFormats[0]!, matrixTagged: false }] } }],
    ['an identity entry without audio codecs', { probe: { ...accept.probe, identityFormats: [{ ...accept.probe.identityFormats[0]!, audioCodecs: [] }] } }],
    ['an identity entry without profiles', { probe: { ...accept.probe, identityFormats: [{ ...accept.probe.identityFormats[0]!, profiles: [] }] } }],
  ])('PF01 rejects an accept with %s', (_name, change) => {
    expect(admits(accept)).toBe(true);
    const value: Record<string, unknown> = { ...accept, ...change };
    for (const [field, entry] of Object.entries(change)) if (entry === undefined) delete value[field];
    expect(admits(value)).toBe(false);
  });
});

describe('one frozen public base for every derived object (inner 1c3a5892 §3.5 server/worker→ingest)', () => {
  it('UB01 an accept carries the public base and no per-object URL', () => {
    expect(videoPresentationIngestRequestSchema.parse(accept)).toEqual(accept);
  });

  it.each([
    ['no public base', { publicBaseURL: undefined }],
    ['an http base', { publicBaseURL: 'http://assets.example.test' }],
    ['a base with a trailing slash', { publicBaseURL: 'https://assets.example.test/' }],
    ['a base that is not a URL', { publicBaseURL: 'assets' }],
    ['the retired packed URL', { packedURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.mp4' }],
    ['the retired manifest URL', { manifestURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.json' }],
    ['the retired ledger URL', { sourceLedgerURL: 'https://assets.example.test/video/canonical.webm.ledger.json' }],
    ['the retired table URL', { sourceLedgerTableURL: 'https://assets.example.test/video/canonical.webm.table.json' }],
  ])('UB02 rejects an accept with %s', (_name, change) => {
    expect(admits(accept)).toBe(true);
    const value: Record<string, unknown> = { ...accept, ...change };
    for (const [field, entry] of Object.entries(change)) if (entry === undefined) delete value[field];
    expect(admits(value)).toBe(false);
  });

  it.each([
    ['the source', KEY],
    ['a work object', `${KEY}.video-presentation:job:chunk:0:a1`],
    ['a nested key', 'video/2026-11-03/clip one.mp4'],
  ])('UB03 the one URL function answers base/key for %s', (_name, key) => {
    const urlFor = exported<(publicBaseURL: string, storageKey: string) => string>('videoPresentationObjectURL');
    expect(urlFor('https://assets.example.test', key)).toBe(`https://assets.example.test/${key}`);
  });
});

describe('E2-3/E2-4 actions on the one presentation route (Q3; §7.1 `Er` takes failure and expiry alike)', () => {
  it('AC01 prepare carries the job identity and no deadline: D comes from the DO', () => {
    const prepare = { action: 'prepare', ...identity };
    expect(videoPresentationIngestRequestSchema.parse(prepare)).toEqual(prepare);
  });

  it.each([
    ['advance_stage', { stage: 'encode' }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 0 }, report: { kind: 'Sub' } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 1 }, report: { kind: 'Done', attempt: 1, usage: 1200 } }],
    ['report_chunk', { unit: { kind: 'presentation-copy' }, report: { kind: 'Fail', attempt: 2, code: 'container_failed', usage: null } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 3 }, report: { kind: 'Exp' } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 3 }, report: { kind: 'Rec', attempt: 1 } }],
    ['report', { fact: { kind: 'finished', usage: { wallMs: 1000, cpuUsec: null } } }],
    // inner 54ce9ea3 §5.1 step 4, §90 E4-15: the worker forwards the job DO's measured receipts of every output it wrote, role-tagged.
    ['report_chunk', { unit: { kind: 'presentation-stitch' }, report: { kind: 'Done', attempt: 1, usage: 1200, receipts: [{ role: 'carrier', packing: 'native', storageKey: `${KEY}.stitch`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4' }] } }],
    ['report_chunk', { unit: { kind: 'presentation-copy' }, report: { kind: 'Done', attempt: 2, usage: 900, receipts: [{ role: 'carrier', packing: 'native', storageKey: `${KEY}.copy`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4' }] } }],
    ['advance_stage', { stage: 'publish' }],
  ])('AC02 %s carries the capability and its own fields', (action, fields) => {
    const request = { action, ...capability, ...fields };
    expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
  });

  it('AC03 fail carries the identity, D and a stable code; expiry is fail with `expired`', () => {
    for (const code of ['expired', 'too_long']) {
      const request = { action: 'fail', ...identity, deadlineAt: D, code };
      expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
    }
  });

  it.each([
    ['the retired run action', { action: 'run', ...identity, deadlineAt: D }],
    ['the retired expire action', { action: 'expire', ...identity, deadlineAt: D }],
    ['advance_stage without its token', { action: 'advance_stage', ...identity, deadlineAt: D, stage: 'encode' }],
    ['advance_stage to an unknown stage', { action: 'advance_stage', ...capability, stage: 'verify' }],
    ['report_chunk with an unknown unit', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-probe' }, report: { kind: 'Sub' } }],
    ['report_chunk Rec without its attempt', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-copy' }, report: { kind: 'Rec' } }],
    ['fail without a code', { action: 'fail', ...identity, deadlineAt: D }],
    // inner 54ce9ea3 §5.1 step 4: the worker never sends a bundle; `verified` stays inside ingest.
    ['report with a verified bundle', { action: 'report', ...capability, fact: { kind: 'verified', bundle: { versionId: 'e'.repeat(64), toolInputId: T, descriptor: {} } } }],
    ['a Done receipt without its hash', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-copy' }, report: { kind: 'Done', attempt: 1, usage: 1, receipts: [{ role: 'carrier', packing: 'native', storageKey: KEY, sizeBytes: 1, contentType: 'video/mp4' }] } }],
    ['fail with a malformed code', { action: 'fail', ...identity, deadlineAt: D, code: 'Too Long' }],
  ])('AC04 rejects %s', (_name, request) => {
    expect(admits({ action: 'prepare', ...identity })).toBe(true);
    expect(admits(request)).toBe(false);
  });
});

// S6e E4-15 (inner#1306 §90) as revised by S6d D3-3 (§91): a stitch or copy Done carries the measured receipt of the one
// carrier its job wrote, tagged with its role and packing; an alpha-packed carrier also carries the packed geometry the
// container reported, and no Done carries a manifest: the presentation DO writes the manifest itself when it assembles the
// bundle and stores it as the `manifest` role. A chunk Done carries none. The worker-only prepare answer exposes each unit's
// stored receipts, the DO's manifest among them once written; the pin sync and the release points take object keys from them.
describe('E4-15 / D3-3 role-tagged output receipts of a stitch or copy (§5.1 step 4; §7.15 candidate 行)', () => {
  const object = (name: string, contentType: string): { storageKey: string; sha256: string; sizeBytes: number; contentType: string } => ({ storageKey: `${KEY}.${name}`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType });
  const native = { role: 'carrier', packing: 'native', ...object('copy', 'video/mp4') };
  // A 95x63 picture packed on 96-wide planes: colour left, alpha right.
  const GEOMETRY = { packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };
  const packedCarrier = { role: 'carrier', packing: 'alpha-packed', ...object('stitch', 'video/mp4'), geometry: GEOMETRY };
  const manifest = { role: 'manifest', ...object('stitch.manifest', 'application/json') };
  const done = (unit: Record<string, unknown>, receipts?: unknown): Record<string, unknown> => ({ action: 'report_chunk', ...capability, unit,
    report: { kind: 'Done', attempt: 1, usage: 1, ...(receipts === undefined ? {} : { receipts }) } });

  it.each([
    ['a copy with its native carrier', done({ kind: 'presentation-copy' }, [native])],
    ['a stitch with its alpha-packed carrier and the packed geometry', done({ kind: 'presentation-stitch' }, [packedCarrier])],
    ['a chunk with no receipts', done({ kind: 'presentation-chunk', chunk: 0 })],
  ])('RR01 accepts %s', (_name, request) => {
    expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['a stitch Done without receipts', done({ kind: 'presentation-stitch' })],
    ['a copy Done with an empty list', done({ kind: 'presentation-copy' }, [])],
    ['no carrier, only a manifest', done({ kind: 'presentation-stitch' }, [manifest])],
    ['two carriers', done({ kind: 'presentation-copy' }, [native, { ...native, storageKey: `${KEY}.copy-2` }])],
    ['a manifest beside an alpha-packed carrier (the DO writes the manifest)', done({ kind: 'presentation-stitch' }, [packedCarrier, manifest])],
    ['a manifest beside a native carrier', done({ kind: 'presentation-copy' }, [native, manifest])],
    ['an alpha-packed carrier without its geometry', done({ kind: 'presentation-stitch' }, [{ ...packedCarrier, geometry: undefined }])],
    ['a native carrier with a geometry', done({ kind: 'presentation-copy' }, [{ ...native, geometry: GEOMETRY }])],
    ['a geometry whose alpha plane overlaps the colour plane', done({ kind: 'presentation-stitch' }, [{ ...packedCarrier, geometry: { ...GEOMETRY, alphaRect: { x: 90, y: 0, width: 95, height: 63 } } }])],
    ['a geometry whose planes differ in size', done({ kind: 'presentation-stitch' }, [{ ...packedCarrier, geometry: { ...GEOMETRY, alphaRect: { x: 96, y: 0, width: 94, height: 63 } } }])],
    ['an unknown role', done({ kind: 'presentation-copy' }, [native, { role: 'thumbnail', ...object('thumb', 'image/png') }])],
    ['a carrier without its packing', done({ kind: 'presentation-copy' }, [{ role: 'carrier', ...object('copy', 'video/mp4') }])],
    ['receipts on a chunk Done', done({ kind: 'presentation-chunk', chunk: 0 }, [native])],
    ['the single receipt field it replaces', { ...done({ kind: 'presentation-copy' }), report: { kind: 'Done', attempt: 1, usage: 1, receipt: object('copy', 'video/mp4') } }],
  ])('RR02 rejects %s', (_name, request) => {
    expect(admits(done({ kind: 'presentation-copy' }, [native]))).toBe(true);
    expect(admits(JSON.parse(JSON.stringify(request)) as Record<string, unknown>)).toBe(false);
  });

  const answer = {
    sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, ledger: null,
    preparation: { targetPolicyVersion: 1, jobId: identity.jobId, stage: 'publish', failure: null },
    capability: { token: 'token-a', deadlineAt: D },
    plan: { route: 'encode', stages: ['plan', 'encode', 'stitch', 'publish'], toolInputId: T, planSha256: PLAN },
    work: { kind: 'encode', chunks: [{ start: 0, end: 96 }] },
    candidateLedger: { state: 'pending', receipt: null, failure: null },
    units: {},
    frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: 1080 } },
  };
  const stitchJob = videoContainerJobId({ kind: 'presentation-stitch', jobId: identity.jobId, attempt: 1 });
  const stitchUnit = (receipts: unknown): Record<string, unknown> => ({ [`video-presentation:${identity.jobId}:stitch`]: {
    state: 'done', attempt: 1, attempts: [{ attempt: 1, jobId: stitchJob, state: 'done', usageRecorded: true }], receipts } });
  const parse = (value: unknown): boolean => exported<{ safeParse: (v: unknown) => { success: boolean } }>('videoPresentationPrepareAnswerSchema').safeParse(value).success;

  it('RR03 the prepare answer exposes a done unit\'s stored receipts: the carrier, and the DO\'s manifest once it wrote one', () => {
    expect(parse({ ...answer, units: stitchUnit([packedCarrier]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit([packedCarrier, manifest]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit([native]) })).toBe(true);
  });

  it.each([
    ['a manifest beside a native carrier', [native, manifest]],
    ['no carrier', [manifest]],
    ['two manifests', [packedCarrier, manifest, { ...manifest, storageKey: `${KEY}.m2` }]],
    ['a manifest stored at the carrier key', [packedCarrier, { ...manifest, storageKey: packedCarrier.storageKey }]],
    ['an alpha-packed carrier without its geometry', [{ ...native, packing: 'alpha-packed' }, manifest]],
  ])('RR04 the prepare answer rejects unit receipts with %s', (_name, receipts) => {
    expect(parse({ ...answer, units: stitchUnit([native]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit(receipts) })).toBe(false);
  });

  // §91 D3-3: the container reports a packed output's geometry; the job report carries it on that output to the worker.
  const measured = { outputIndex: 0, storageKey: `${KEY}.stitch`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4', width: 192, height: 64, durationSeconds: 2, upright: null, cover: null };
  const report = (output: Record<string, unknown>): Record<string, unknown> => ({ schemaVersion: 2, state: 'done', outputs: [output], usage: { wallMs: 1, cpuUsec: 1 } });

  it('JR01 a done job report carries a packed output\'s geometry, and an output without one stays as it was', () => {
    expect(miniToolPlanJobReportSchema.parse(report({ ...measured, packing: GEOMETRY }))).toMatchObject({ outputs: [{ packing: GEOMETRY }] });
    expect(miniToolPlanJobReportSchema.safeParse(report(measured)).success).toBe(true);
  });

  it.each([
    ['a negative packed width', { ...GEOMETRY, packedWidth: -192 }],
    ['an alpha plane that overlaps the colour plane', { ...GEOMETRY, alphaRect: { x: 90, y: 0, width: 95, height: 63 } }],
    ['a rectangle without its height', { ...GEOMETRY, colorRect: { x: 0, y: 0, width: 95 } }],
  ])('JR02 a job report rejects a packing with %s', (_name, packing) => {
    expect(miniToolPlanJobReportSchema.safeParse(report({ ...measured, packing: GEOMETRY })).success).toBe(true);
    expect(miniToolPlanJobReportSchema.safeParse(report({ ...measured, packing })).success).toBe(false);
  });
});

describe('E2-3 the worker-only prepare answer (§5.1 step 1 「worker 从 DO 的回答取 D」, §7.6 frozen pricing)', () => {
  const ledger = { state: 'pending', receipt: null, failure: null };
  const answer = {
    sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, ledger: null,
    preparation: { targetPolicyVersion: 1, jobId: identity.jobId, stage: 'plan', failure: null },
    capability: { token: 'token-a', deadlineAt: D },
    plan: { route: 'encode', stages: ['plan', 'encode', 'stitch', 'publish'], toolInputId: T, planSha256: PLAN },
    work: { kind: 'encode', chunks: [{ start: 0, end: 48 }, { start: 48, end: 96 }] },
    candidateLedger: ledger,
    units: {},
    // S6d D3b-1 (§91): the carrier encode parameters frozen at admission, so every chunk of a job encodes alike (§5.4).
    frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: 1080 } },
  };
  const parse = (value: unknown): boolean => exported<{ safeParse: (v: unknown) => { success: boolean } }>('videoPresentationPrepareAnswerSchema').safeParse(value).success;

  it('PA01 parses a started encode job with its chunk windows, candidate ledger, unit set and frozen facts', () => {
    expect(parse(answer)).toBe(true);
    const unitKey = `video-presentation:${identity.jobId}:chunk:0`;
    const units = { [unitKey]: { state: 'open', attempt: 1, attempts: [{ attempt: 1, jobId: videoContainerJobId({ kind: 'presentation-chunk', jobId: identity.jobId, chunk: 0, attempt: 1 }), state: 'pending', usageRecorded: false }] } };
    expect(parse({ ...answer, units })).toBe(true);
  });

  const DISPATCHED_COPY = { plan: { ...answer.plan, route: 'dispatch_copy', stages: ['plan', 'dispatch_copy', 'publish'] }, work: { kind: 'dispatch_copy' } };

  it.each(['copy', 'encode', null])('PA04 parses a dispatched copy whose audio is %s (§94 D8)', (copyAudio) => {
    expect(parse({ ...answer, ...DISPATCHED_COPY, copyAudio })).toBe(true);
  });

  it('PA02 parses a job that was not granted: no capability, plan or work', () => {
    expect(parse({ ...answer, capability: null, plan: null, work: { kind: 'none' }, candidateLedger: null, units: {} })).toBe(true);
  });

  it.each([
    ['no capability but a plan', { capability: null }],
    ['encode work under a copy route', { plan: { ...answer.plan, route: 'copy', stages: ['plan', 'copy', 'publish'] } }],
    ['dispatch-copy work under an encode route', { work: { kind: 'dispatch_copy' } }],
    ['stages that are not the route\'s', { plan: { ...answer.plan, stages: ['plan', 'publish'] } }],
    ['chunks not starting at frame 0', { work: { kind: 'encode', chunks: [{ start: 1, end: 48 }] } }],
    ['chunks with a gap', { work: { kind: 'encode', chunks: [{ start: 0, end: 48 }, { start: 50, end: 96 }] } }],
    ['an empty chunk', { work: { kind: 'encode', chunks: [{ start: 0, end: 0 }] } }],
    ['no chunks', { work: { kind: 'encode', chunks: [] } }],
    ['a candidate ledger receipt for another toolInputId', { candidateLedger: { state: 'ready', failure: null, receipt: {
      schemaVersion: 2, sourceFingerprint: H, toolInputId: 'b'.repeat(64), planSha256: PLAN, producerVersion: 2, attempt: { jobId: identity.jobId, deadlineAt: D },
      url: 'https://assets.example.test/l.json', etag: '"e"', size: 9, sha256: 'b'.repeat(64), contentType: 'application/json',
      table: { url: 'https://assets.example.test/t.json', sha256: 'c'.repeat(64), size: 8, contentType: 'application/json', frameCount: 3 } } } }],
    ['no frozen standard-4 price', { frozen: { ...answer.frozen, pricing: { basic: PRICING.basic } } }],
    ['no frozen carrier parameters', { frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null } }],
    ['a frozen crf out of range', { frozen: { ...answer.frozen, carrier: { crf: 52, preset: 'medium', maxShortSide: 1080 } } }],
    ['a deadline outside the capability', { deadlineAt: D }],
    // §94 D8 (design §7.17 copy_carrier row): exactly a dispatched copy names its audio, from the probe's audioCopyable.
    ['a dispatched copy without its copyAudio', DISPATCHED_COPY],
    ['copyAudio under an encode route', { copyAudio: 'copy' }],
  ])('PA03 rejects an answer with %s', (_name, change) => {
    expect(parse(answer)).toBe(true);
    expect(parse({ ...answer, ...change })).toBe(false);
  });
});

describe('E2-5 one key per sub-job and the outer recipe shapes (§5.4 「job id、产出key、操作身份与用量身份用同一字符串」, §7.17)', () => {
  const chunkJob = videoContainerJobId({ kind: 'presentation-chunk', jobId: identity.jobId, chunk: 2, attempt: 1 });

  it('WK01 derives the output key from the storage key and the full job id, distinct per attempt and from every companion key', () => {
    const keyFor = exported<(storageKey: string, jobId: string) => string>('videoPresentationWorkKeyFor');
    const key = keyFor(KEY, chunkJob);
    expect(keyFor(KEY, chunkJob)).toBe(key);
    expect(key.startsWith(`${KEY}.`)).toBe(true);
    expect(key).toContain(chunkJob);
    const retry = videoContainerJobId({ kind: 'presentation-chunk', jobId: identity.jobId, chunk: 2, attempt: 2 });
    expect(keyFor(KEY, retry)).not.toBe(key);
    expect(new Set([key, videoPresentationKeyFor(KEY), videoSourceLedgerKeyFor(KEY, 'e'.repeat(64)), KEY]).size).toBe(4);
  });

  // S6d D3 (§91 D-1, D-2, D3-1; design §7.17 `segment`/`chunk_encode` rows): the worker reads the full ledger and writes the
  // window's clip spans in presentation order (decodeStart, clipStart, displayStart/displayEnd and rate each their own
  // field) with derived-empty spans as `{ kind: 'empty', fill, window }`, plus the target block from the plan; the
  // container never reads the full ledger. A stitch binds each chunk as a job input and carries the plan duration of each.
  const r = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
  const TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
  const SPAN = { kind: 'source', decodeStart: r(8, 5), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(49, 25), rate: r(1) };
  const EMPTY = { kind: 'empty', fill: 'black', window: { start: r(49, 25), end: r(2) } };
  const ENTRIES = [SPAN, EMPTY];
  // §91 D3b-10/11: audio is placed by the plan's audio spans (or, with none, at movie time less the origin).
  const AUDIO = { start: r(0), end: r(2), origin: r(0), spans: [{ sourceStart: r(8, 375), sourceEnd: r(758, 375), presentationStart: r(0), rate: r(1) }] };
  const CHUNK_A = '6c3b1d2e-0a4f-4d5e-9b8a-1c2d3e4f5a6b';
  const CHUNK_B = '7d4c2e3f-1b5a-4e6f-8c9b-2d3e4f5a6b7c';
  const chunkEncode = { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 50 }, timescale: 25, entries: ENTRIES, target: TARGET };
  const stitch = { kind: 'stitch', inputId: INPUT, chunks: [{ inputId: CHUNK_A, duration: r(48, 25) }, { inputId: CHUNK_B, duration: r(2, 25) }], audio: AUDIO, target: TARGET };
  const modelInput = { kind: 'prepare_model_input', inputId: INPUT, window: { start: 48, end: 50 }, timescale: 25, entries: ENTRIES, target: TARGET, audio: { ...AUDIO, start: r(48, 25) } };
  const chunkInputs = [{ inputId: CHUNK_A, storageKey: `${KEY}.c0` }, { inputId: CHUNK_B, storageKey: `${KEY}.c1` }];

  /**
   * A standard-4 job request around one recipe, binding every input it names.
   * @param recipe - The recipe.
   * @param inputs - Extra bound inputs.
   * @returns The request.
   */
  function jobOf(recipe: Record<string, unknown>, inputs: { inputId: string; storageKey: string }[] = []): Record<string, unknown> {
    return {
      schemaVersion: 2, jobId: chunkJob, containerClass: 'MiniToolContainerStd4', deadlineAt: D,
      limits: { probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
      inputs: [{ inputId: INPUT, storageKey: KEY }, ...inputs],
      outputs: [{ outputIndex: 0, storageKey: `${KEY}.${chunkJob}`, contentType: 'video/mp4', recipe }],
    };
  }

  it.each([
    // §94 D8 (design §7.17 copy_carrier row): the audio is copied, encoded over the stitch's audioOf entries, or absent.
    ['copy_carrier copying the audio', { kind: 'copy_carrier', inputId: INPUT, colorMatrix: 'bt601', origin: AUDIO.origin, audio: { kind: 'copy' } }, false],
    ['copy_carrier encoding the audio', { kind: 'copy_carrier', inputId: INPUT, colorMatrix: 'bt601', origin: AUDIO.origin, audio: { kind: 'encode', ...AUDIO } }, false],
    ['copy_carrier without audio', { kind: 'copy_carrier', inputId: INPUT, colorMatrix: 'bt601', origin: AUDIO.origin, audio: null }, false],
    ['chunk_encode', chunkEncode, false],
    ['stitch', stitch, true],
    ['stitch without audio', { ...stitch, audio: null }, true],
    ['stitch audio of a track with no edit list', { ...stitch, audio: { ...AUDIO, spans: null } }, true],
    ['chunk_encode for an odd, padded carrier', { ...chunkEncode, target: { ...TARGET, width: 162, height: 98, displayRect: { x: 0, y: 0, width: 161, height: 97 } } }, false],
    ['chunk_encode tone mapping HDR', { ...chunkEncode, target: { ...TARGET, toneMap: 'sdr-bt709' } }, false],
    // S6e E3b (§7.17, §5.3): the model input over its presentation window, written as an intermediate object.
    ['prepare_model_input', modelInput, false],
    // §91 D3-4: the model input pads odd sides with a displayRect like a chunk, and carries no audio when the source has none.
    ['prepare_model_input for an odd, padded picture without audio', { ...modelInput, audio: null, target: { ...TARGET, width: 162, height: 98, displayRect: { x: 0, y: 0, width: 161, height: 97 } } }, false],
  ] as const)('RC01 admits the %s recipe on a standard-4 job request', (_name, recipe, withChunks) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
    const request = jobOf(recipe, withChunks ? chunkInputs : []);
    expect(miniToolPlanJobRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['the earlier window-only chunk', { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 96 } }],
    ['a chunk of no entries', { ...chunkEncode, entries: [] }],
    ['entries that leave a gap', { ...chunkEncode, entries: [SPAN, { ...EMPTY, window: { start: r(2), end: r(51, 25) } }] }],
    ['entries that overlap', { ...chunkEncode, entries: [{ ...SPAN, displayEnd: r(2) }, EMPTY] }],
    ['a span that ends at its start', { ...chunkEncode, entries: [{ ...SPAN, displayEnd: r(48, 25) }, { ...EMPTY, window: { start: r(48, 25), end: r(2) } }] }],
    ['a span decoded from after its clip start', { ...chunkEncode, entries: [{ ...SPAN, decodeStart: r(49, 25) }, EMPTY] }],
    ['a span of zero rate', { ...chunkEncode, entries: [{ ...SPAN, rate: r(0) }, EMPTY] }],
    ['a span named by the earlier sourceStart', { ...chunkEncode, entries: [{ kind: 'source', sourceStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(49, 25), rate: r(1) }, EMPTY] }],
    ['two empty entries in a row', { ...chunkEncode, entries: [SPAN, { ...EMPTY, window: { start: r(49, 25), end: r(99, 50) } }, { ...EMPTY, window: { start: r(99, 50), end: r(2) } }] }],
    ['an empty entry of another fill', { ...chunkEncode, entries: [SPAN, { ...EMPTY, fill: 'white' }] }],
    ['a target without its tone map', { ...chunkEncode, target: { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', alpha: 'none', crf: 18, preset: 'medium' } }],
    ['a display rectangle outside the coded size', { ...chunkEncode, target: { ...TARGET, displayRect: { x: 0, y: 0, width: 321, height: 180 } } }],
    ['an odd coded size', { ...chunkEncode, target: { ...TARGET, width: 161 } }],
    ['an unknown alpha packing', { ...chunkEncode, target: { ...TARGET, alpha: 'stacked' } }],
    ['the earlier key-list stitch', { kind: 'stitch', inputId: INPUT, chunks: ['video/canonical.webm.c0'] }],
    ['a stitch chunk without its duration', { ...stitch, chunks: [{ inputId: CHUNK_A }] }],
    ['a stitch of no chunks', { ...stitch, chunks: [] }],
    ['a stitch whose chunk is the source input', { ...stitch, chunks: [{ inputId: INPUT, duration: r(2) }] }],
    ['a copy without the plan matrix', { kind: 'copy_carrier', inputId: INPUT, audio: null }],
    ['a copy without its audio field (§94 D8)', { kind: 'copy_carrier', inputId: INPUT, colorMatrix: 'bt601', origin: AUDIO.origin }],
    ['a copy without the plan origin (§7.16 start row)', { kind: 'copy_carrier', inputId: INPUT, colorMatrix: 'bt601', audio: null }],
    ['a model input without its window', { kind: 'prepare_model_input', inputId: INPUT, timescale: 25, entries: ENTRIES, target: TARGET, audio: null }],
    ['a stitch audio without its origin', { ...stitch, audio: { start: r(0), end: r(2), spans: null } }],
    ['a stitch audio without its spans field', { ...stitch, audio: { start: r(0), end: r(2), origin: r(0) } }],
    ['an audio span of zero rate', { ...stitch, audio: { ...AUDIO, spans: [{ ...AUDIO.spans[0], rate: r(0) }] } }],
    ['a model input without its audio field', { kind: 'prepare_model_input', inputId: INPUT, window: { start: 48, end: 50 }, timescale: 25, entries: ENTRIES, target: TARGET }],
  ])('RC02 rejects %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.safeParse(chunkEncode).success).toBe(true);
    expect(miniToolPlanRecipeSchema.safeParse(recipe).success).toBe(false);
  });

  // S6d D4-3 (§92; design §7.17 frame row): a frame names one D3-style entry and its PNG target, never a presentation ordinal.
  const FRAME_TARGET = { width: 320, height: 180, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };
  const frameRecipe = { kind: 'frame', inputId: INPUT, entry: SPAN, target: FRAME_TARGET };

  it.each([
    ['a source entry', frameRecipe],
    ['a derived-empty entry', { ...frameRecipe, entry: EMPTY }],
    ['a 16-bit, tone-mapped, alpha-keeping target', { ...frameRecipe, target: { ...FRAME_TARGET, pngBitDepth: 16, toneMap: 'sdr-bt709', alpha: 'straight' } }],
    // The existing display crop (people candidates), in the display geometry of the target.
    ['a display crop', { ...frameRecipe, crop: { sourceWidth: 320, sourceHeight: 180, rect: { x: 2, y: 2, width: 100, height: 80 } } }],
  ])('FR01 admits a frame recipe with %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it.each([
    ['the earlier frameIndex shape', { kind: 'frame', inputId: INPUT, frameIndex: 30, orientation: 'display' }],
    ['no entry', { kind: 'frame', inputId: INPUT, target: FRAME_TARGET }],
    ['a frameIndex beside the entry', { ...frameRecipe, frameIndex: 30 }],
    ['a 12-bit PNG', { ...frameRecipe, target: { ...FRAME_TARGET, pngBitDepth: 12 } }],
    ['a packed alpha', { ...frameRecipe, target: { ...FRAME_TARGET, alpha: 'packed' } }],
    ['a target without its tone map', { ...frameRecipe, target: { width: 320, height: 180, colorMatrix: 'bt709', pngBitDepth: 8, alpha: 'none' } }],
    ['a crop whose source size is not the target\'s', { ...frameRecipe, crop: { sourceWidth: 640, sourceHeight: 360, rect: { x: 2, y: 2, width: 100, height: 80 } } }],
  ])('FR02 rejects a frame recipe with %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.safeParse(frameRecipe).success).toBe(true);
    expect(miniToolPlanRecipeSchema.safeParse(recipe).success).toBe(false);
  });

  // S6d D4-6 (§92; design §7.17 scene_cuts 「去掉inspect_video步骤」): the inspect_video recipe has no producer after D4.
  it('DP07 the inspect_video recipe is no longer admitted', () => {
    expect(miniToolPlanRecipeSchema.safeParse({ kind: 'inspect_video', inputId: INPUT }).success).toBe(false);
  });

  // S6d D5 (§93; design §7.17 frame row 「不得把presentation ordinal当原解码n」): the transitional frame pieces are gone once the
  // last frameIndex producer (the people candidate crop, run-container-analysis.ts) writes entries: the recipe schema is one
  // discriminated union on kind with a single frame member (no `.or(entryFrame)`), whose type and schema name no frameIndex
  // or orientation at all (no `frameIndex?: never; orientation?: never`).
  it('FR03 the recipe schema is one discriminated union on kind, without a second frame schema beside it', () => {
    expect((miniToolPlanRecipeSchema.def as { discriminator?: unknown }).discriminator).toBe('kind');
  });

  it.each([['frameIndex'], ['orientation']])('FR04 a frame recipe that carries %s, even undefined, is refused', (field) => {
    expect(miniToolPlanRecipeSchema.safeParse({ ...frameRecipe, [field]: undefined }).success).toBe(false);
  });

  it('FR05 the frame recipe type declares no frameIndex or orientation (typecheck)', () => {
    const entry = { kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(1, 25), rate: r(1) } as const;
    const target = { width: 320, height: 180, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' } as const;
    // @ts-expect-error The frame recipe type has no frameIndex property (an excess property once `frameIndex?: never` is gone).
    const withFrameIndex: Extract<MiniToolPlanRecipe, { kind: 'frame' }> = { kind: 'frame', inputId: INPUT, entry, target, frameIndex: undefined };
    // @ts-expect-error The frame recipe type has no orientation property (an excess property once `orientation?: never` is gone).
    const withOrientation: Extract<MiniToolPlanRecipe, { kind: 'frame' }> = { kind: 'frame', inputId: INPUT, entry, target, orientation: undefined };
    expect([withFrameIndex.kind, withOrientation.kind]).toEqual(['frame', 'frame']);
  });

  it('RC03 a stitch job request binds every chunk it names as an input', () => {
    expect(miniToolPlanJobRequestSchema.safeParse(jobOf(stitch, chunkInputs)).success).toBe(true);
    expect(miniToolPlanJobRequestSchema.safeParse(jobOf(stitch, chunkInputs.slice(0, 1))).success).toBe(false);
  });
});
