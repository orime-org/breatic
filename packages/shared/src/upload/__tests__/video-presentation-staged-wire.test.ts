// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The staged presentation wire between the worker and ingest (inner#1306 test
 * plan §90 E2; frames-split design §5.1 steps 1, 2 and 2a, §5.4, §7.1, §7.1.1,
 * §7.17; interface choices E2-1 to E2-5).
 *
 * E2-1: the accept freezes an `encoding` sibling (chunk share, parallel cap, the
 * encoder rates per decode key and edit tier with the tone-map rate, the edit file
 * settings and size cap, the carrier short side and colour; frames-split §5.4 估算
 * row, §4.2). E2-3/E2-4: `prepare` replaces `run`; `fail` absorbs `expire`; the
 * follow-up actions carry the capability (identity, D and token). The worker-only
 * prepare answer is the snapshot plus capability, plan (one of the four §7.1
 * routes), work (playback and edit-file chunks on the grid), the job's unit set
 * and the frozen pricing and attribution; the ledger and the copy routes are gone
 * with the frame table (§3.4). E2-5: one key function names a sub-job's output from
 * its job id; the grid recipe shapes are the §7.17 ones the container tests use.
 */

import { describe, expect, it } from 'vitest';
import * as shared from '../../index.js';
import { videoPresentationIngestRequestSchema } from '../video-presentation-ingest.js';
import { miniToolPlanJobReportSchema, miniToolPlanJobRequestSchema, miniToolPlanRecipeSchema } from '../mini-tool-plan-job.js';
import { videoContainerJobId } from '../../mini-tools/video-encode-plan.js';
import type { MiniToolPlanRecipe } from '../mini-tool-plan-types.js';
import { videoPresentationKeyFor } from '../video-presentation.js';

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
const EDIT_TIERS = { edit_h264_intra_8bit_420: 1500e6, edit_h264_intra_10bit_420: 1200e6, edit_h264_intra_8bit_444: 1100e6, edit_h264_intra_10bit_444: 900e6, edit_prores: 950e6 };
const DECODE = {
  sdr_8bit: 910e6, sdr_10bit: 810e6, sdr_12bit: 690e6, sdr_alpha_layer: 600e6, sdr_prores: 820e6, sdr_dnx: 735e6, sdr_av1_8bit: 740e6, sdr_av1_10bit: 570e6,
  sdr_av1_12bit: 610e6, sdr_jpeg2000: 25e6, sdr_ffv1: 75e6, sdr_png: 340e6, sdr_other: 1080e6, ...EDIT_TIERS,
};
const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, tonemapPixelsPerSecond: 1170e6, decodeConvertPixelsPerSecond: DECODE, editEncodePixelsPerSecond: EDIT_TIERS, aacEncodeSecondsPerSecond: 100 },
  edit: { crf: 15, preset: 'medium', proresProfile: '4444', bytesPerPixel: 0.5, maxEditBytes: 2147483648 },
  carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const WITHOUT_ALPHA_LAYER = Object.fromEntries(Object.entries(DECODE).filter(([key]) => key !== 'sdr_alpha_layer'));
const accept = {
  action: 'accept', storageKey: KEY, sourceFingerprint: H, jobId: 'video-presentation-a', deadlineAt: D,
  original: null, contentType: 'video/webm',
  limits: { maxSourceBytes: 1, maxPackedBytes: 1, crf: 18, preset: 'medium', probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
  pricing: PRICING, targetPolicyVersion: 1, policy: { chunkRetries: 3, maxAutoRepairs: 3 }, encoding: ENCODING,
  // S6d D1 (§91 D-6): the probe's sample count and the plan's single-frame duration are frozen at admission.
  probe: { sampleFrames: 1, singleFrameDurationMs: 5000, maxFps: 120 },
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
    // frames-split §5.4 估算 row: every source decode key and edit tier is frozen; sdr_16bit and the hdr_* keys are gone.
    ['a missing alpha-layer decode rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: WITHOUT_ALPHA_LAYER } }],
    ['the retired sdr_16bit key', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { ...DECODE, sdr_16bit: 1 } } }],
    ['a missing edit encode rate', { ...ENCODING, encoder: { ...ENCODING.encoder, editEncodePixelsPerSecond: { ...EDIT_TIERS, edit_prores: undefined } } }],
    ['no tone-map rate', { ...ENCODING, encoder: { ...ENCODING.encoder, tonemapPixelsPerSecond: undefined } }],
    ['no edit file settings', { ...ENCODING, edit: undefined }],
    ['a zero edit size cap', { ...ENCODING, edit: { ...ENCODING.edit, maxEditBytes: 0 } }],
    ['the retired copy margin', { ...ENCODING, copyDiskMarginBytes: 33554432 }],
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
    const snapshot = { sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, readmit,
      preparation: { targetPolicyVersion: 1, jobId: 'video-presentation-a', stage: 'publish', failure: readmit ? null : 'presentation_invalid' } };
    expect(schema.safeParse(snapshot).success).toBe(true);
  });
});

describe('S6d D1 frozen probe facts on the accept (inner#1306 §91 D-6; design §5.1 step 2, §4.1)', () => {
  it.each([
    ['no probe facts', { probe: undefined }],
    ['no sample count', { probe: { singleFrameDurationMs: 5000, maxFps: 120 } }],
    ['a zero sample count', { probe: { ...accept.probe, sampleFrames: 0 } }],
    ['a fractional sample count', { probe: { ...accept.probe, sampleFrames: 1.5 } }],
    ['no single-frame duration', { probe: { sampleFrames: 1, maxFps: 120 } }],
    ['a zero single-frame duration', { probe: { ...accept.probe, singleFrameDurationMs: 0 } }],
    ['an unknown probe field', { probe: { ...accept.probe, decodeAll: true } }],
    // frames-split §4.1 帧率 row: `presentation.max_fps` is frozen for the rate rule; the identity table is gone (§3.4).
    ['no rate cap', { probe: { sampleFrames: 1, singleFrameDurationMs: 5000 } }],
    ['a zero rate cap', { probe: { ...accept.probe, maxFps: 0 } }],
    ['the retired identity table', { probe: { ...accept.probe, identityFormats: [] } }],
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

  const carrier = { role: 'carrier', packing: 'native', storageKey: `${KEY}.stitch`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4' };
  const editFile = { role: 'edit', storageKey: `${KEY}.edit`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4', tier: 'edit_h264_intra_8bit_420' };
  const count = { lastVideoTime: { numerator: 59, denominator: 30 }, sourceFrames: 60 };

  it.each([
    ['advance_stage', { stage: 'encode' }],
    ['advance_stage', { stage: 'count' }],
    ['advance_stage', { stage: 'edit_stitch' }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 0 }, report: { kind: 'Sub' } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 1 }, report: { kind: 'Done', attempt: 1, usage: 1200 } }],
    ['report_chunk', { unit: { kind: 'presentation-edit', chunk: 1 }, report: { kind: 'Done', attempt: 1, usage: 1200 } }],
    ['report_chunk', { unit: { kind: 'presentation-edit-stitch' }, report: { kind: 'Fail', attempt: 2, code: 'grid_mismatch', usage: null } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 3 }, report: { kind: 'Exp' } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 3 }, report: { kind: 'Rec', attempt: 1 } }],
    ['report', { fact: { kind: 'finished', usage: { wallMs: 1000, cpuUsec: null } } }],
    // §4.1 帧数 row: the count reports the last real frame's display time and the decoded frames, and writes nothing.
    ['report_chunk', { unit: { kind: 'presentation-count' }, report: { kind: 'Done', attempt: 1, usage: 300, count } }],
    // §5.1 step 4: the worker forwards the job DO's measured receipt of the one output a stitch wrote, role-tagged.
    ['report_chunk', { unit: { kind: 'presentation-stitch' }, report: { kind: 'Done', attempt: 1, usage: 1200, receipts: [carrier] } }],
    ['report_chunk', { unit: { kind: 'presentation-edit-stitch' }, report: { kind: 'Done', attempt: 2, usage: 900, receipts: [editFile] } }],
    ['advance_stage', { stage: 'publish' }],
  ])('AC02 %s carries the capability and its own fields', (action, fields) => {
    const request = { action, ...capability, ...fields };
    expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
  });

  it('AC03 fail carries the identity, D and a stable code; expiry is fail with `expired`', () => {
    for (const code of ['expired', 'too_long', 'edit_over_cap']) {
      const request = { action: 'fail', ...identity, deadlineAt: D, code };
      expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
    }
  });

  it.each([
    ['the retired run action', { action: 'run', ...identity, deadlineAt: D }],
    ['the retired expire action', { action: 'expire', ...identity, deadlineAt: D }],
    ['advance_stage without its token', { action: 'advance_stage', ...identity, deadlineAt: D, stage: 'encode' }],
    ['advance_stage to an unknown stage', { action: 'advance_stage', ...capability, stage: 'verify' }],
    ['advance_stage to the retired copy stage', { action: 'advance_stage', ...capability, stage: 'copy' }],
    ['report_chunk with an unknown unit', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-probe' }, report: { kind: 'Sub' } }],
    ['report_chunk on the retired copy unit', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-copy' }, report: { kind: 'Sub' } }],
    ['report_chunk Rec without its attempt', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-stitch' }, report: { kind: 'Rec' } }],
    ['fail without a code', { action: 'fail', ...identity, deadlineAt: D }],
    // §5.1 step 4: the worker never sends a bundle; `verified` stays inside ingest.
    ['report with a verified bundle', { action: 'report', ...capability, fact: { kind: 'verified', bundle: { versionId: 'e'.repeat(64), toolInputId: T, descriptor: {} } } }],
    ['a count Done without its count', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-count' }, report: { kind: 'Done', attempt: 1, usage: 1 } }],
    ['a count beside a chunk Done', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-chunk', chunk: 0 }, report: { kind: 'Done', attempt: 1, usage: 1, count } }],
    ['an edit stitch Done naming a carrier', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-edit-stitch' }, report: { kind: 'Done', attempt: 1, usage: 1, receipts: [carrier] } }],
    ['a stitch Done naming an edit file', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-stitch' }, report: { kind: 'Done', attempt: 1, usage: 1, receipts: [editFile] } }],
    ['an edit receipt without its tier', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-edit-stitch' }, report: { kind: 'Done', attempt: 1, usage: 1, receipts: [{ ...editFile, tier: undefined }] } }],
    ['fail with a malformed code', { action: 'fail', ...identity, deadlineAt: D, code: 'Too Long' }],
  ])('AC04 rejects %s', (_name, request) => {
    expect(admits({ action: 'prepare', ...identity })).toBe(true);
    expect(admits(JSON.parse(JSON.stringify(request)) as Record<string, unknown>)).toBe(false);
  });
});

// A stitch Done carries the measured receipt of the one carrier its job wrote, tagged with its role and packing; an
// alpha-packed carrier also carries the packed geometry the container reported, and no Done carries a manifest: the
// presentation DO writes the manifest itself when it assembles the bundle and stores it as the `manifest` role. A chunk
// Done carries none. The worker-only prepare answer exposes each unit's stored receipts, the DO's manifest among them.
describe('E4-15 / D3-3 role-tagged output receipts of a stitch (§5.1 step 4; §7.15 candidate 行)', () => {
  const object = (name: string, contentType: string): { storageKey: string; sha256: string; sizeBytes: number; contentType: string } => ({ storageKey: `${KEY}.${name}`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType });
  const native = { role: 'carrier', packing: 'native', ...object('stitch', 'video/mp4') };
  // A 95x63 picture packed on 96-wide planes: colour left, alpha right.
  const GEOMETRY = { packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };
  const packedCarrier = { role: 'carrier', packing: 'alpha-packed', ...object('stitch', 'video/mp4'), geometry: GEOMETRY };
  const manifest = { role: 'manifest', ...object('stitch.manifest', 'application/json') };
  const stitch = { kind: 'presentation-stitch' };
  const done = (unit: Record<string, unknown>, receipts?: unknown): Record<string, unknown> => ({ action: 'report_chunk', ...capability, unit,
    report: { kind: 'Done', attempt: 1, usage: 1, ...(receipts === undefined ? {} : { receipts }) } });

  it.each([
    ['a stitch with its native carrier', done(stitch, [native])],
    ['a stitch with its alpha-packed carrier and the packed geometry', done(stitch, [packedCarrier])],
    ['a chunk with no receipts', done({ kind: 'presentation-chunk', chunk: 0 })],
  ])('RR01 accepts %s', (_name, request) => {
    expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['a stitch Done without receipts', done(stitch)],
    ['a stitch Done with an empty list', done(stitch, [])],
    ['no carrier, only a manifest', done(stitch, [manifest])],
    ['two carriers', done(stitch, [native, { ...native, storageKey: `${KEY}.stitch-2` }])],
    ['a manifest beside an alpha-packed carrier (the DO writes the manifest)', done(stitch, [packedCarrier, manifest])],
    ['an alpha-packed carrier without its geometry', done(stitch, [{ ...packedCarrier, geometry: undefined }])],
    ['a native carrier with a geometry', done(stitch, [{ ...native, geometry: GEOMETRY }])],
    ['a geometry whose alpha plane overlaps the colour plane', done(stitch, [{ ...packedCarrier, geometry: { ...GEOMETRY, alphaRect: { x: 90, y: 0, width: 95, height: 63 } } }])],
    ['a geometry whose planes differ in size', done(stitch, [{ ...packedCarrier, geometry: { ...GEOMETRY, alphaRect: { x: 96, y: 0, width: 94, height: 63 } } }])],
    ['an unknown role', done(stitch, [native, { role: 'thumbnail', ...object('thumb', 'image/png') }])],
    ['a carrier without its packing', done(stitch, [{ role: 'carrier', ...object('stitch', 'video/mp4') }])],
    ['receipts on a chunk Done', done({ kind: 'presentation-chunk', chunk: 0 }, [native])],
    ['the single receipt field it replaces', { ...done(stitch), report: { kind: 'Done', attempt: 1, usage: 1, receipt: object('stitch', 'video/mp4') } }],
  ])('RR02 rejects %s', (_name, request) => {
    expect(admits(done(stitch, [native]))).toBe(true);
    expect(admits(JSON.parse(JSON.stringify(request)) as Record<string, unknown>)).toBe(false);
  });

  const answer = {
    sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null,
    preparation: { targetPolicyVersion: 1, jobId: identity.jobId, stage: 'publish', failure: null },
    capability: { token: 'token-a', deadlineAt: D },
    plan: { route: 'encode', stages: ['plan', 'count', 'encode', 'stitch', 'publish'], toolInputId: T, planSha256: PLAN },
    work: { kind: 'encode', chunks: [{ start: 0, end: 96 }] },
    units: {},
    frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: 1080 } },
  };
  const stitchJob = videoContainerJobId({ kind: 'presentation-stitch', jobId: identity.jobId, attempt: 1 });
  const stitchUnit = (receipts: unknown): Record<string, unknown> => ({ [`video-presentation:${identity.jobId}:stitch`]: {
    state: 'done', attempt: 1, attempts: [{ attempt: 1, jobId: stitchJob, state: 'done', usageRecorded: true }], receipts } });
  const parse = (value: unknown): boolean => exported<{ safeParse: (v: unknown) => { success: boolean } }>('videoPresentationPrepareAnswerSchema').safeParse(value).success;

  it('RR03 the prepare answer exposes a done unit\'s stored receipts: the carrier, the DO\'s manifest once it wrote one, an edit file', () => {
    expect(parse({ ...answer, units: stitchUnit([packedCarrier]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit([packedCarrier, manifest]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit([native]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit([{ role: 'edit', ...object('edit', 'video/mp4'), tier: 'edit_prores' }]) })).toBe(true);
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

describe('E2-3 the worker-only prepare answer (§5.1 step 1 「worker 从 DO 的回答取 D」, §7.1 routes, §7.6 frozen pricing)', () => {
  const answer = {
    sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null,
    preparation: { targetPolicyVersion: 1, jobId: identity.jobId, stage: 'plan', failure: null },
    capability: { token: 'token-a', deadlineAt: D },
    plan: { route: 'encode', stages: ['plan', 'count', 'encode', 'stitch', 'publish'], toolInputId: T, planSha256: PLAN },
    work: { kind: 'encode', chunks: [{ start: 0, end: 48 }, { start: 48, end: 96 }] },
    units: {},
    // S6d D3b-1 (§91): the carrier encode parameters frozen at admission, so every chunk of a job encodes alike (§5.4).
    frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: 1080 } },
  };
  const EDIT = {
    plan: { route: 'edit', stages: ['plan', 'count', 'edit', 'edit_stitch', 'encode', 'stitch', 'publish'], toolInputId: null, planSha256: PLAN },
    work: { kind: 'edit', editChunks: [{ start: 0, end: 96 }], chunks: [{ start: 0, end: 48 }, { start: 48, end: 96 }] },
  };
  const parse = (value: unknown): boolean => exported<{ safeParse: (v: unknown) => { success: boolean } }>('videoPresentationPrepareAnswerSchema').safeParse(value).success;

  it('PA01 parses a started encode job with its chunk windows, unit set and frozen facts', () => {
    expect(parse(answer)).toBe(true);
    const unitKey = `video-presentation:${identity.jobId}:chunk:0`;
    const units = { [unitKey]: { state: 'open', attempt: 1, attempts: [{ attempt: 1, jobId: videoContainerJobId({ kind: 'presentation-chunk', jobId: identity.jobId, chunk: 0, attempt: 1 }), state: 'pending', usageRecorded: false }] } };
    expect(parse({ ...answer, units })).toBe(true);
  });

  it('PA04 parses each route with its work: the edit route before its toolInputId is known, reuse_edit, reuse', () => {
    expect(parse({ ...answer, ...EDIT })).toBe(true);
    expect(parse({ ...answer, plan: { ...answer.plan, route: 'reuse_edit', stages: ['plan', 'encode', 'stitch', 'publish'] } })).toBe(true);
    expect(parse({ ...answer, plan: { ...answer.plan, route: 'reuse', stages: ['plan', 'publish'] }, work: { kind: 'none' } })).toBe(true);
  });

  it('PA02 parses a job that was not granted: no capability, plan or work', () => {
    expect(parse({ ...answer, capability: null, plan: null, work: { kind: 'none' }, units: {} })).toBe(true);
  });

  it.each([
    ['no capability but a plan', { capability: null }],
    ['a retired copy route', { plan: { ...answer.plan, route: 'copy', stages: ['plan', 'copy', 'publish'] } }],
    ['encode work under the edit route', { plan: EDIT.plan }],
    ['edit work under the encode route', { work: EDIT.work }],
    ['work under the reuse route', { plan: { ...answer.plan, route: 'reuse', stages: ['plan', 'publish'] } }],
    ['an unknown toolInputId outside the edit route', { plan: { ...answer.plan, toolInputId: null } }],
    ['stages that are not the route\'s', { plan: { ...answer.plan, stages: ['plan', 'encode', 'stitch', 'publish'] } }],
    ['chunks not starting at frame 0', { work: { kind: 'encode', chunks: [{ start: 1, end: 48 }] } }],
    ['chunks with a gap', { work: { kind: 'encode', chunks: [{ start: 0, end: 48 }, { start: 50, end: 96 }] } }],
    ['an empty chunk', { work: { kind: 'encode', chunks: [{ start: 0, end: 0 }] } }],
    ['no chunks', { work: { kind: 'encode', chunks: [] } }],
    ['a retired candidate ledger', { candidateLedger: null }],
    ['no frozen standard-4 price', { frozen: { ...answer.frozen, pricing: { basic: PRICING.basic } } }],
    ['no frozen carrier parameters', { frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null } }],
    ['a frozen crf out of range', { frozen: { ...answer.frozen, carrier: { crf: 52, preset: 'medium', maxShortSide: 1080 } } }],
    ['a deadline outside the capability', { deadlineAt: D }],
  ])('PA03 rejects an answer with %s', (_name, change) => {
    expect(parse(answer)).toBe(true);
    expect(parse({ ...answer, ...change })).toBe(false);
  });
});

describe('E2-5 one key per sub-job and the grid recipe shapes (§5.4 「job id、产出key、操作身份与用量身份用同一字符串」, §7.17)', () => {
  const chunkJob = videoContainerJobId({ kind: 'presentation-chunk', jobId: identity.jobId, chunk: 2, attempt: 1 });

  it('WK01 derives the output key from the storage key and the full job id, distinct per attempt and from the descriptor key', () => {
    const keyFor = exported<(storageKey: string, jobId: string) => string>('videoPresentationWorkKeyFor');
    const key = keyFor(KEY, chunkJob);
    expect(keyFor(KEY, chunkJob)).toBe(key);
    expect(key.startsWith(`${KEY}.`)).toBe(true);
    expect(key).toContain(chunkJob);
    const retry = videoContainerJobId({ kind: 'presentation-chunk', jobId: identity.jobId, chunk: 2, attempt: 2 });
    expect(keyFor(KEY, retry)).not.toBe(key);
    expect(new Set([key, videoPresentationKeyFor(KEY), KEY]).size).toBe(3);
  });

  // §7.17: the worker writes the grid, the tool source and the frames from the frozen plan; the container reads no P. A
  // stitch binds each chunk as a job input with the grid frames it holds, and reads the original's audio over the grid.
  const r = (numerator: number, denominator = 1): { numerator: number; denominator: number } => ({ numerator, denominator });
  const GRID = { fps: r(25), gridStart: r(0), frameCount: 50, realFrameCount: 49 };
  const ORIGINAL = { kind: 'original', keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false } };
  const TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
  const CHUNK_A = '6c3b1d2e-0a4f-4d5e-9b8a-1c2d3e4f5a6b';
  const CHUNK_B = '7d4c2e3f-1b5a-4e6f-8c9b-2d3e4f5a6b7c';
  const EDIT_INPUT = '8e5d3f4a-2c6b-4f7a-9d0c-3e4f5a6b7c8d';
  const chunkEncode = { kind: 'chunk_encode', inputId: INPUT, grid: GRID, source: ORIGINAL, frames: { start: 48, end: 50 }, target: TARGET };
  const stitch = { kind: 'stitch', inputId: INPUT, grid: GRID, chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: 48 } }, { inputId: CHUNK_B, frames: { start: 48, end: 50 } }], audio: true, target: TARGET };
  const editStitch = { kind: 'stitch', grid: GRID, chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: 48 } }, { inputId: CHUNK_B, frames: { start: 48, end: 50 } }], edit: { profile: 'edit_h264_intra_8bit_420' } };
  const modelInput = { kind: 'prepare_model_input', inputId: INPUT, grid: GRID, source: ORIGINAL, frames: { start: 48, end: 50 }, target: TARGET, audio: true };
  const editEncode = {
    kind: 'edit_encode', inputId: INPUT, grid: GRID, source: ORIGINAL, frames: { start: 0, end: 25 }, edit: { profile: 'edit_h264_intra_10bit_444', crf: 15, preset: 'medium' },
    color: { matrix: 'bt2020nc', transfer: 'smpte2084', primaries: 'bt2020', range: 'tv', chromaLocation: 'left' }, toneMap: 'sdr-bt709',
  };
  const gridCount = { kind: 'grid_count', inputId: INPUT, gridStart: r(1, 100), fps: r(30000, 1001), gridEnd: r(2) };
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
    ['grid_count', gridCount, []],
    ['grid_count of a video without audio', { ...gridCount, gridEnd: null }, []],
    ['edit_encode tone mapping HDR once', editEncode, []],
    ['chunk_encode', chunkEncode, []],
    ['chunk_encode read from the edit file', { ...chunkEncode, source: { kind: 'edit' } }, []],
    ['stitch', stitch, chunkInputs],
    ['stitch without audio', { ...stitch, audio: false }, chunkInputs],
    ['the edit file stitch', editStitch, chunkInputs],
    ['chunk_encode for an odd, padded carrier', { ...chunkEncode, target: { ...TARGET, width: 162, height: 98, displayRect: { x: 0, y: 0, width: 161, height: 97 } } }, []],
    // S6e E3b (§7.17, §5.3): the model input over its grid frames, written as an intermediate object.
    ['prepare_model_input', modelInput, []],
    ['prepare_model_input from the edit file with the original\'s audio', { ...modelInput, source: { kind: 'edit' }, audioInputId: EDIT_INPUT }, [{ inputId: EDIT_INPUT, storageKey: `${KEY}.original` }]],
    ['prepare_model_input for an odd, padded picture without audio', { ...modelInput, audio: false, target: { ...TARGET, width: 162, height: 98, displayRect: { x: 0, y: 0, width: 161, height: 97 } } }, []],
  ] as const)('RC01 admits the %s recipe on a standard-4 job request', (_name, recipe, inputs) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
    const request = jobOf(recipe, [...inputs]);
    expect(miniToolPlanJobRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['the earlier window-only chunk', { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 96 } }],
    ['the retired frame-table chunk', { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 50 }, timescale: 25, entries: [], target: TARGET }],
    ['a chunk without its grid', { ...chunkEncode, grid: undefined }],
    ['a chunk without its tool source', { ...chunkEncode, source: undefined }],
    ['a chunk of empty frames', { ...chunkEncode, frames: { start: 48, end: 48 } }],
    ['a chunk past the grid', { ...chunkEncode, frames: { start: 48, end: 51 } }],
    ['a grid with more real frames than slots', { ...chunkEncode, grid: { ...GRID, realFrameCount: 51 } }],
    ['a string fps', { ...chunkEncode, grid: { ...GRID, fps: { numerator: '25', denominator: '1' } } }],
    ['an original source without its keyframe statistics', { ...chunkEncode, source: { kind: 'original' } }],
    ['an unknown source kind', { ...chunkEncode, source: { kind: 'proxy' } }],
    ['a target without its tone map', { ...chunkEncode, target: { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', alpha: 'none', crf: 18, preset: 'medium' } }],
    ['a display rectangle outside the coded size', { ...chunkEncode, target: { ...TARGET, displayRect: { x: 0, y: 0, width: 321, height: 180 } } }],
    ['an odd coded size', { ...chunkEncode, target: { ...TARGET, width: 161 } }],
    ['an unknown alpha packing', { ...chunkEncode, target: { ...TARGET, alpha: 'stacked' } }],
    ['the earlier key-list stitch', { kind: 'stitch', inputId: INPUT, chunks: ['video/canonical.webm.c0'] }],
    ['a stitch chunk without its frames', { ...stitch, chunks: [{ inputId: CHUNK_A }] }],
    ['a stitch chunk with the retired duration', { ...stitch, chunks: [{ inputId: CHUNK_A, duration: r(2) }] }],
    ['stitch chunks that leave a gap', { ...stitch, chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: 40 } }, { inputId: CHUNK_B, frames: { start: 48, end: 50 } }] }],
    ['a stitch of no chunks', { ...stitch, chunks: [] }],
    ['a stitch whose chunk is the source input', { ...stitch, chunks: [{ inputId: INPUT, frames: { start: 0, end: 50 } }] }],
    ['a stitch without its grid', { ...stitch, grid: undefined }],
    ['an edit stitch with audio', { ...editStitch, audio: false }],
    ['an edit stitch of an unknown tier', { ...editStitch, edit: { profile: 'edit_hevc' } }],
    ['an edit encode without its colour inputs', { ...editEncode, color: undefined }],
    ['an edit encode of an unknown tier', { ...editEncode, edit: { ...editEncode.edit, profile: 'edit_hevc' } }],
    ['a grid count without its rate', { ...gridCount, fps: undefined }],
    ['the retired copy carrier', { kind: 'copy_carrier', inputId: INPUT, colorMatrix: 'bt601', origin: r(0), audio: null }],
    ['a model input without its frames', { ...modelInput, frames: undefined }],
    ['a model input without its audio field', { ...modelInput, audio: undefined }],
  ])('RC02 rejects %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.safeParse(chunkEncode).success).toBe(true);
    expect(miniToolPlanRecipeSchema.safeParse(JSON.parse(JSON.stringify(recipe))).success).toBe(false);
  });

  // §7.17 frame row: a frame names one grid frame of the tool source and its PNG target.
  const FRAME_TARGET = { width: 320, height: 180, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };
  const frameRecipe = { kind: 'frame', inputId: INPUT, grid: GRID, source: ORIGINAL, frameIndex: 30, target: FRAME_TARGET };

  it.each([
    ['an original tool source', frameRecipe],
    ['an edit-file tool source', { ...frameRecipe, source: { kind: 'edit' } }],
    ['a hold frame past the real frames', { ...frameRecipe, frameIndex: 49 }],
    ['a 16-bit, alpha-keeping target', { ...frameRecipe, target: { ...FRAME_TARGET, pngBitDepth: 16, alpha: 'straight' } }],
    // The display crop (people candidates, the video focus crop §5.5), in the display geometry of the target.
    ['a display crop', { ...frameRecipe, crop: { sourceWidth: 320, sourceHeight: 180, rect: { x: 2, y: 2, width: 100, height: 80 } } }],
  ])('FR01 admits a frame recipe with %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it.each([
    ['the earlier orientation shape', { kind: 'frame', inputId: INPUT, frameIndex: 30, orientation: 'display' }],
    ['the retired frame-table entry', { kind: 'frame', inputId: INPUT, entry: { kind: 'source' }, target: FRAME_TARGET }],
    ['no frame number', { ...frameRecipe, frameIndex: undefined }],
    ['a frame past the grid', { ...frameRecipe, frameIndex: 50 }],
    ['seconds beside the frame', { ...frameRecipe, pts: 1.2 }],
    ['a 12-bit PNG', { ...frameRecipe, target: { ...FRAME_TARGET, pngBitDepth: 12 } }],
    ['a packed alpha', { ...frameRecipe, target: { ...FRAME_TARGET, alpha: 'packed' } }],
    ['a target without its tone map', { ...frameRecipe, target: { width: 320, height: 180, colorMatrix: 'bt709', pngBitDepth: 8, alpha: 'none' } }],
    ['a crop whose source size is not the target\'s', { ...frameRecipe, crop: { sourceWidth: 640, sourceHeight: 360, rect: { x: 2, y: 2, width: 100, height: 80 } } }],
  ])('FR02 rejects a frame recipe with %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.safeParse(frameRecipe).success).toBe(true);
    expect(miniToolPlanRecipeSchema.safeParse(JSON.parse(JSON.stringify(recipe))).success).toBe(false);
  });

  // §7.17 scene_cuts 「去掉inspect_video步骤」: the inspect_video recipe has no producer.
  it('DP07 the inspect_video recipe is no longer admitted', () => {
    expect(miniToolPlanRecipeSchema.safeParse({ kind: 'inspect_video', inputId: INPUT }).success).toBe(false);
  });

  it('FR03 the recipe schema is one discriminated union on kind, without a second frame schema beside it', () => {
    expect((miniToolPlanRecipeSchema.def as { discriminator?: unknown }).discriminator).toBe('kind');
  });

  it('FR05 the frame recipe type declares no orientation (typecheck)', () => {
    const target = { width: 320, height: 180, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' } as const;
    const source = { kind: 'edit' } as const;
    // @ts-expect-error The frame recipe type has no orientation property.
    const withOrientation: Extract<MiniToolPlanRecipe, { kind: 'frame' }> = { kind: 'frame', inputId: INPUT, grid: GRID, source, frameIndex: 0, target, orientation: undefined };
    expect(withOrientation.kind).toBe('frame');
  });

  it('RC03 a stitch job request binds every chunk it names as an input', () => {
    expect(miniToolPlanJobRequestSchema.safeParse(jobOf(stitch, chunkInputs)).success).toBe(true);
    expect(miniToolPlanJobRequestSchema.safeParse(jobOf(stitch, chunkInputs.slice(0, 1))).success).toBe(false);
  });
});
