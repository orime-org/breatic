// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  encoder: { startSeconds: 3, encodePixelsPerSecond: 163000000, decodeConvertPixelsPerSecond: { sdr_8bit: 1950000000, sdr_10bit: 705000000, hdr_8bit: 152000000, hdr_10bit: 103000000 } },
  copyDiskMarginBytes: 33554432,
  carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const accept = {
  action: 'accept', storageKey: KEY, sourceFingerprint: H, jobId: 'video-presentation-a', deadlineAt: D,
  original: null, contentType: 'video/webm',
  limits: { maxSourceBytes: 1, maxPackedBytes: 1, crf: 18, preset: 'medium', probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
  pricing: PRICING, targetPolicyVersion: 1, policy: { chunkRetries: 3, maxAutoRepairs: 3 }, encoding: ENCODING,
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
    ['a missing HDR 10-bit rate', { ...ENCODING, encoder: { ...ENCODING.encoder, decodeConvertPixelsPerSecond: { sdr_8bit: 1, sdr_10bit: 1, hdr_8bit: 1 } } }],
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
    ['report_chunk', { unit: { kind: 'presentation-stitch' }, report: { kind: 'Done', attempt: 1, usage: 1200 } }],
    ['report_chunk', { unit: { kind: 'presentation-copy' }, report: { kind: 'Fail', attempt: 2, code: 'container_failed', usage: null } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 3 }, report: { kind: 'Exp' } }],
    ['report_chunk', { unit: { kind: 'presentation-chunk', chunk: 3 }, report: { kind: 'Rec', attempt: 1 } }],
    ['report', { fact: { kind: 'finished', usage: { wallMs: 1000, cpuUsec: null } } }],
    // inner 54ce9ea3 §5.1 step 4: the worker forwards the job DO's measured receipt of the carrier it wrote.
    ['report_chunk', { unit: { kind: 'presentation-stitch' }, report: { kind: 'Done', attempt: 1, usage: 1200, receipt: { storageKey: `${KEY}.stitch`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4' } } }],
    ['report_chunk', { unit: { kind: 'presentation-copy' }, report: { kind: 'Done', attempt: 2, usage: 900, receipt: { storageKey: `${KEY}.copy`, sha256: 'f'.repeat(64), sizeBytes: 4096, contentType: 'video/mp4' } } }],
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
    ['a Done receipt without its hash', { action: 'report_chunk', ...capability, unit: { kind: 'presentation-copy' }, report: { kind: 'Done', attempt: 1, usage: 1, receipt: { storageKey: KEY, sizeBytes: 1, contentType: 'video/mp4' } } }],
    ['fail with a malformed code', { action: 'fail', ...identity, deadlineAt: D, code: 'Too Long' }],
  ])('AC04 rejects %s', (_name, request) => {
    expect(admits({ action: 'prepare', ...identity })).toBe(true);
    expect(admits(request)).toBe(false);
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
    expect(new Set([key, videoPresentationKeyFor(KEY), videoSourceLedgerKeyFor(KEY), KEY]).size).toBe(4);
  });

  it.each([
    ['copy_carrier', { kind: 'copy_carrier', inputId: INPUT }],
    ['chunk_encode', { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 96 } }],
    ['stitch', { kind: 'stitch', inputId: INPUT, chunks: ['video/canonical.webm.c0', 'video/canonical.webm.c1'] }],
  ])('RC01 admits the %s recipe on a standard-4 job request', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
    const request = {
      schemaVersion: 2, jobId: chunkJob, containerClass: 'MiniToolContainerStd4', deadlineAt: D,
      limits: { probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
      inputs: [{ inputId: INPUT, storageKey: KEY }],
      outputs: [{ outputIndex: 0, storageKey: `${KEY}.${chunkJob}`, contentType: 'video/mp4', recipe }],
    };
    expect(miniToolPlanJobRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['a chunk window ending at its start', { kind: 'chunk_encode', inputId: INPUT, window: { start: 48, end: 48 } }],
    ['a negative chunk window', { kind: 'chunk_encode', inputId: INPUT, window: { start: -1, end: 4 } }],
    ['a stitch of no chunks', { kind: 'stitch', inputId: INPUT, chunks: [] }],
    ['clip entries, which are S6d\'s', { kind: 'chunk_encode', inputId: INPUT, window: { start: 0, end: 4 }, entries: [] }],
  ])('RC02 rejects %s', (_name, recipe) => {
    expect(miniToolPlanRecipeSchema.safeParse({ kind: 'copy_carrier', inputId: INPUT }).success).toBe(true);
    expect(miniToolPlanRecipeSchema.safeParse(recipe).success).toBe(false);
  });
});
