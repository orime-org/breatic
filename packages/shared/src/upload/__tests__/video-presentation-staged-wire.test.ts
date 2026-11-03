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
import { miniToolPlanJobRequestSchema, miniToolPlanRecipeSchema } from '../mini-tool-plan-job.js';
import { videoContainerJobId } from '../../mini-tools/video-encode-plan.js';
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
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000 } },
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
    ['a missing HDR 10-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, sdr_12bit: 1, hdr_8bit: 1, hdr_12bit: 1 } } }],
    // S6d D1-3 (§91): the 12-bit rates are frozen with the others.
    ['a missing SDR 12-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, hdr_8bit: 1, hdr_10bit: 1, hdr_12bit: 1 } } }],
    ['a missing HDR 12-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, sdr_12bit: 1, hdr_8bit: 1, hdr_10bit: 1 } } }],
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

// S6e E4-15 (inner#1306 §90): a stitch or copy Done carries the measured receipts of every output its job wrote, each
// tagged with its role: exactly one carrier, and a manifest exactly when the carrier is alpha-packed. A chunk Done
// carries none. The DO stores them per attempt and the worker-only prepare answer exposes each unit's done receipts;
// the pin sync and the release points take object keys from them (no key rule for the manifest).
describe('E4-15 role-tagged output receipts of a stitch or copy (§5.1 step 4; §7.15 candidate 行)', () => {
  const object = (name: string, contentType: string): { storageKey: string; sha256: string; sizeBytes: number; contentType: string } => ({ storageKey: `${KEY}.${name}`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType });
  const native = { role: 'carrier', packing: 'native', ...object('copy', 'video/mp4') };
  const packedCarrier = { role: 'carrier', packing: 'alpha-packed', ...object('stitch', 'video/mp4') };
  const manifest = { role: 'manifest', ...object('stitch.manifest', 'application/json') };
  const done = (unit: Record<string, unknown>, receipts?: unknown): Record<string, unknown> => ({ action: 'report_chunk', ...capability, unit,
    report: { kind: 'Done', attempt: 1, usage: 1, ...(receipts === undefined ? {} : { receipts }) } });

  it.each([
    ['a copy with its native carrier', done({ kind: 'presentation-copy' }, [native])],
    ['a stitch with its alpha-packed carrier and manifest', done({ kind: 'presentation-stitch' }, [packedCarrier, manifest])],
    ['the same two in the other order', done({ kind: 'presentation-stitch' }, [manifest, packedCarrier])],
    ['a chunk with no receipts', done({ kind: 'presentation-chunk', chunk: 0 })],
  ])('RR01 accepts %s', (_name, request) => {
    expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['a stitch Done without receipts', done({ kind: 'presentation-stitch' })],
    ['a copy Done with an empty list', done({ kind: 'presentation-copy' }, [])],
    ['no carrier, only a manifest', done({ kind: 'presentation-stitch' }, [manifest])],
    ['two carriers', done({ kind: 'presentation-copy' }, [native, { ...native, storageKey: `${KEY}.copy-2` }])],
    ['a manifest beside a native carrier', done({ kind: 'presentation-copy' }, [native, manifest])],
    ['an alpha-packed carrier without its manifest', done({ kind: 'presentation-stitch' }, [packedCarrier])],
    ['two manifests', done({ kind: 'presentation-stitch' }, [packedCarrier, manifest, { ...manifest, storageKey: `${KEY}.m2` }])],
    ['a manifest stored at the carrier key', done({ kind: 'presentation-stitch' }, [packedCarrier, { ...manifest, storageKey: packedCarrier.storageKey }])],
    ['an unknown role', done({ kind: 'presentation-copy' }, [native, { role: 'thumbnail', ...object('thumb', 'image/png') }])],
    ['a carrier without its packing', done({ kind: 'presentation-copy' }, [{ role: 'carrier', ...object('copy', 'video/mp4') }])],
    ['receipts on a chunk Done', done({ kind: 'presentation-chunk', chunk: 0 }, [native])],
    ['the single receipt field it replaces', { ...done({ kind: 'presentation-copy' }), report: { kind: 'Done', attempt: 1, usage: 1, receipt: object('copy', 'video/mp4') } }],
  ])('RR02 rejects %s', (_name, request) => {
    expect(admits(done({ kind: 'presentation-copy' }, [native]))).toBe(true);
    expect(admits(request)).toBe(false);
  });

  const answer = {
    sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, ledger: null,
    preparation: { targetPolicyVersion: 1, jobId: identity.jobId, stage: 'publish', failure: null },
    capability: { token: 'token-a', deadlineAt: D },
    plan: { route: 'encode', stages: ['plan', 'encode', 'stitch', 'publish'], toolInputId: T, planSha256: PLAN },
    work: { kind: 'encode', chunks: [{ start: 0, end: 96 }] },
    candidateLedger: { state: 'pending', receipt: null, failure: null },
    units: {},
    frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null },
  };
  const stitchJob = videoContainerJobId({ kind: 'presentation-stitch', jobId: identity.jobId, attempt: 1 });
  const stitchUnit = (receipts: unknown): Record<string, unknown> => ({ [`video-presentation:${identity.jobId}:stitch`]: {
    state: 'done', attempt: 1, attempts: [{ attempt: 1, jobId: stitchJob, state: 'done', usageRecorded: true }], receipts } });
  const parse = (value: unknown): boolean => exported<{ safeParse: (v: unknown) => { success: boolean } }>('videoPresentationPrepareAnswerSchema').safeParse(value).success;

  it('RR03 the prepare answer exposes a done unit\'s receipts', () => {
    expect(parse({ ...answer, units: stitchUnit([packedCarrier, manifest]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit([native]) })).toBe(true);
  });

  it.each([
    ['a manifest beside a native carrier', [native, manifest]],
    ['no carrier', [manifest]],
    ['an alpha-packed carrier without its manifest', [packedCarrier]],
  ])('RR04 the prepare answer rejects unit receipts with %s', (_name, receipts) => {
    expect(parse({ ...answer, units: stitchUnit([native]) })).toBe(true);
    expect(parse({ ...answer, units: stitchUnit(receipts) })).toBe(false);
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
    frozen: { pricing: PRICING, actorUserId: accept.actorUserId, projectId: null },
  };
  const parse = (value: unknown): boolean => exported<{ safeParse: (v: unknown) => { success: boolean } }>('videoPresentationPrepareAnswerSchema').safeParse(value).success;

  it('PA01 parses a started encode job with its chunk windows, candidate ledger, unit set and frozen facts', () => {
    expect(parse(answer)).toBe(true);
    const unitKey = `video-presentation:${identity.jobId}:chunk:0`;
    const units = { [unitKey]: { state: 'open', attempt: 1, attempts: [{ attempt: 1, jobId: videoContainerJobId({ kind: 'presentation-chunk', jobId: identity.jobId, chunk: 0, attempt: 1 }), state: 'pending', usageRecorded: false }] } };
    expect(parse({ ...answer, units })).toBe(true);
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
    ['a deadline outside the capability', { deadlineAt: D }],
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
  const CHUNK_A = '6c3b1d2e-0a4f-4d5e-9b8a-1c2d3e4f5a6b';
  const CHUNK_B = '7d4c2e3f-1b5a-4e6f-8c9b-2d3e4f5a6b7c';
  const chunkEncode = { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 50 }, timescale: 25, entries: ENTRIES, target: TARGET };
  const stitch = { kind: 'stitch', inputId: INPUT, chunks: [{ inputId: CHUNK_A, duration: r(48, 25) }, { inputId: CHUNK_B, duration: r(2, 25) }], audio: { start: r(0), end: r(2) }, target: TARGET };
  const modelInput = { kind: 'prepare_model_input', inputId: INPUT, window: { start: 48, end: 50 }, timescale: 25, entries: ENTRIES, target: TARGET, audio: { start: r(48, 25), end: r(2) } };
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
    ['copy_carrier', { kind: 'copy_carrier', inputId: INPUT, colorMatrix: 'bt601' }, false],
    ['chunk_encode', chunkEncode, false],
    ['stitch', stitch, true],
    ['stitch without audio', { ...stitch, audio: null }, true],
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
    ['a copy without the plan matrix', { kind: 'copy_carrier', inputId: INPUT }],
    ['a model input without its window', { kind: 'prepare_model_input', inputId: INPUT, timescale: 25, entries: ENTRIES, target: TARGET, audio: null }],
    ['a model input without its audio field', { kind: 'prepare_model_input', inputId: INPUT, window: { start: 48, end: 50 }, timescale: 25, entries: ENTRIES, target: TARGET }],
  ])('RC02 rejects %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.safeParse(chunkEncode).success).toBe(true);
    expect(miniToolPlanRecipeSchema.safeParse(recipe).success).toBe(false);
  });

  it('RC03 a stitch job request binds every chunk it names as an input', () => {
    expect(miniToolPlanJobRequestSchema.safeParse(jobOf(stitch, chunkInputs)).success).toBe(true);
    expect(miniToolPlanJobRequestSchema.safeParse(jobOf(stitch, chunkInputs.slice(0, 1))).success).toBe(false);
  });
});
