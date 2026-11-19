// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The worker's staged presentation job (inner#1306 test plan §90 E2; frames-split
 * design §5.1 steps 1, 2 and 2a, §5.4 作业身份, §7.1, §7.1.1, §7.6; interface
 * choices E2-3 to E2-7 and E2-9).
 *
 * One durable job per presentation jobId, following `advance-plan-job.ts`: each
 * pickup reads the DO once through `prepare` (D comes only from its capability)
 * and the `/jobs` state of the attempts it knows, submits only the next allowed
 * stage or attempt, and throws StillRunning while work is in flight. Sub-jobs
 * run on the frozen standard-4 class with §5.4 job ids and the shared key
 * function; each attempt's usage is recorded once as a platform expense keyed by
 * its full job id, then marked with `report_chunk Rec`. At D the job fails
 * `expired`. The ingest boundary is faked at `fetch`, so the tests do not depend
 * on which shared client the handler uses.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as shared from '@breatic/shared';
import { videoContainerJobId } from '@breatic/shared/mini-tools';
import type * as coreModule from '@breatic/core';
import { containerCostUsd } from '@breatic/domain';
import * as handler from '@worker/handlers/video-presentation.js';
import { StillRunning } from '@worker/handlers/still-running.js';

const { findById, createUsageRecorder, recordServiceCall, settle, syncPresentationPins, logger } = vi.hoisted(() => ({
  findById: vi.fn(), createUsageRecorder: vi.fn(), recordServiceCall: vi.fn(), settle: vi.fn(), syncPresentationPins: vi.fn(),
  // Every application-layer catch logs (root AGENTS.md "Application-layer error logging"); the spy lets the handler do so.
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@breatic/core', async (original) => {
  const actual = await original<typeof coreModule>();
  return {
    ...actual,
    env: { INGEST_BASE_URL: 'https://ingest.example.test', INGEST_SHARED_SECRET: 'secret' },
    logger,
    getMiniToolsConfig: () => ({ ...actual.getMiniToolsConfig(), poll_interval_ms: 5000 }),
  };
});
vi.mock('@breatic/domain', async (original) => ({
  ...await original<Record<string, unknown>>(),
  assetRepo: { findById },
  createUsageRecorder,
  // S6e E4-3: the domain function that writes candidate and selected pins from the prepare answer.
  syncPresentationPins,
}));

// S6d D3b (§91 D3-6): the worker builds each recipe from the candidate's full ledger. The fixtures are full ledgers the
// container's own probe and ledger actions wrote for generated media (see fixtures/presentation/PROVENANCE.txt).
const LEDGERS = {
  cfr96: readFileSync(new URL('./fixtures/presentation/cfr96.ledger.json', import.meta.url)),
  cut: readFileSync(new URL('./fixtures/presentation/cut.ledger.json', import.meta.url)),
};
const CFR96 = JSON.parse(LEDGERS.cfr96.toString('utf8')) as { sourceFingerprint: string; toolInputId: string; planSha256: string };
const H = CFR96.sourceFingerprint;
const T = CFR96.toolInputId;
const PLAN = CFR96.planSha256;
// The bytes the ledger URL serves, and their identity; a case may serve another full ledger.
let ledgerBytes: Buffer = LEDGERS.cfr96;
// A transport failure of the ledger read, before any body (RB06).
let ledgerFault: 'reset' | 503 | null = null;
const KEY = 'video/canonical.webm';
const JOB = 'video-presentation-a';
const ACTOR = '6061c056-f758-47c1-9527-8495ecba60e3';
const asset = { id: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: H, storageKey: KEY, kind: 'video', deletedAt: null, mimeType: 'video/webm' };
const data = { assetId: asset.id, sourceFingerprint: H, jobId: JOB };
const price = (containerClass: string, vcpu: number, memory: number, disk: number): { containerClass: string; size: { vcpu: number; memory_gib: number; disk_gb: number }; prices: { vcpu_second_usd: number; memory_gib_second_usd: number; disk_gb_second_usd: number } } => ({
  containerClass, size: { vcpu, memory_gib: memory, disk_gb: disk }, prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.000003, disk_gb_second_usd: 0.0000001 },
});
const PRICING = { basic: price('MediaContainer', 0.25, 1, 4), standard4: price('MiniToolContainerStd4', 4, 12, 20) };
const RECEIPT = {
  schemaVersion: 2, sourceFingerprint: H, toolInputId: T, planSha256: PLAN, producerVersion: 2, attempt: { jobId: JOB, deadlineAt: 0 },
  url: `https://assets.example.test/${KEY}.ledger.json`, etag: '"e"', size: LEDGERS.cfr96.byteLength, sha256: createHash('sha256').update(LEDGERS.cfr96).digest('hex'), contentType: 'application/json',
  table: { url: `https://assets.example.test/${KEY}.table.json`, sha256: 'c'.repeat(64), size: 81, contentType: 'application/json', frameCount: 96 },
};
const r = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
// §91 D-2: the carrier target from the plan (320x180 needs no cap or padding, BT.709, SDR, opaque) and the frozen crf/preset.
// §91 D3b-10/11: the stitch places audio by the plan's audio spans (cfr96: the AAC priming edit).
const AUDIO_SPANS = (JSON.parse(LEDGERS.cfr96.toString('utf8')) as { plan: { audioSpans: unknown } }).plan.audioSpans;
const TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
const STAGES: Record<string, string[]> = { identity: ['plan', 'publish'], copy: ['plan', 'copy', 'publish'], dispatch_copy: ['plan', 'dispatch_copy', 'publish'], encode: ['plan', 'encode', 'stitch', 'publish'] };

interface Sent { path: string; method: string; body: Record<string, unknown> | null }
let sent: Sent[] = [];
let answer: Record<string, unknown>;
let reports: Map<string, Record<string, unknown>>;
let D: number;

type Unit = { state: string; attempt: number; attempts: { attempt: number; jobId: string; state: string; usageRecorded: boolean }[] };

/**
 * A worker-only prepare answer.
 * @param fields - What differs from a granted encode job with a ready candidate ledger.
 * @returns It.
 */
function prepareAnswer(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const route = (fields.route as string | undefined) ?? 'encode';
  const { route: _route, ...rest } = fields;
  return {
    sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, ledger: null,
    preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'plan', failure: null },
    capability: { token: 'token-a', deadlineAt: D },
    plan: { route, stages: STAGES[route], toolInputId: T, planSha256: PLAN },
    work: route === 'encode' ? { kind: 'encode', chunks: [{ start: 0, end: 48 }, { start: 48, end: 96 }] } : route === 'dispatch_copy' ? { kind: 'dispatch_copy' } : { kind: 'none' },
    candidateLedger: { state: 'ready', receipt: { ...RECEIPT, attempt: { jobId: JOB, deadlineAt: D } }, failure: null },
    // §94 D8 (design §7.17 copy_carrier row): exactly a dispatched copy names its audio, the DO's choice from the probe's
    // audioCopyable. cfr96 has audio; the default is the encode a dispatched copy mostly exists for, and a case overrides it.
    ...(route === 'dispatch_copy' ? { copyAudio: 'encode' } : {}),
    units: {},
    // §91 D3b-1: the carrier encode parameters frozen at admission.
    frozen: { pricing: PRICING, actorUserId: ACTOR, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: 1080 } },
    ...rest,
  };
}

/**
 * The §5.4 id of one presentation sub-job attempt.
 * @param kind - The unit kind.
 * @param attempt - The attempt number.
 * @param chunk - The chunk index for chunks.
 * @returns The job id.
 */
function subJob(kind: 'chunk' | 'stitch' | 'copy', attempt: number, chunk = 0): string {
  if (kind === 'chunk') return videoContainerJobId({ kind: 'presentation-chunk', jobId: JOB, chunk, attempt });
  return videoContainerJobId({ kind: kind === 'stitch' ? 'presentation-stitch' : 'presentation-copy', jobId: JOB, attempt });
}

/**
 * The output key of one sub-job, from the shared key function.
 * @param jobId - The sub-job id.
 * @returns The key.
 */
function workKey(jobId: string): string {
  const keyFor = (shared as Record<string, unknown>).videoPresentationWorkKeyFor as ((storageKey: string, id: string) => string) | undefined;
  expect(keyFor, 'videoPresentationWorkKeyFor is exported from @breatic/shared').toBeTypeOf('function');
  return keyFor!(KEY, jobId);
}

/**
 * One unit with a single attempt.
 * @param jobId - The attempt's job id.
 * @param state - The unit state.
 * @param attemptState - The attempt state.
 * @param attempt - The attempt number.
 * @param usageRecorded - Whether its usage is recorded.
 * @returns It.
 */
function unit(jobId: string, state: string, attemptState: string, attempt = 1, usageRecorded = false): Unit {
  return { state, attempt, attempts: [{ attempt, jobId, state: attemptState, usageRecorded }] };
}

/**
 * The staged step under test, read at call time so a missing export fails each case on its own.
 * @returns It.
 */
function advance(): (job: typeof data) => Promise<unknown> {
  const fn = (handler as Record<string, unknown>).advanceVideoPresentation;
  expect(fn, 'advanceVideoPresentation is exported from @worker/handlers/video-presentation.js').toBeTypeOf('function');
  return fn as (job: typeof data) => Promise<unknown>;
}

/**
 * Requests to the presentation route with this action.
 * @param action - The action.
 * @returns Their bodies in order.
 */
function actions(action: string): Record<string, unknown>[] {
  return sent.filter((call) => call.path === '/video-presentation' && call.body?.action === action).map((call) => call.body!);
}

/**
 * Container jobs submitted to `/jobs`.
 * @returns Their requests in order.
 */
function submitted(): Record<string, unknown>[] {
  return sent.filter((call) => call.path === '/jobs' && call.method === 'POST').map((call) => call.body!);
}

/**
 * The index of the first call matching a predicate.
 * @param match - The predicate.
 * @returns The index.
 */
function indexOf(match: (call: Sent) => boolean): number {
  return sent.findIndex(match);
}

/**
 * A finished `/jobs` report for a submitted request shape.
 * @param jobId - The sub-job id.
 * @param state - Done or failed.
 * @param usage - Its measured usage.
 * @returns The report.
 */
function finished(jobId: string, state: 'done' | 'failed', usage: { wallMs: number; cpuUsec: number | null } | null): Record<string, unknown> {
  const output = { outputIndex: 0, storageKey: workKey(jobId), sha256: 'f'.repeat(64), sizeBytes: 100, contentType: 'video/mp4' };
  return state === 'done' ? { schemaVersion: 2, state, outputs: [output], usage } : { schemaVersion: 2, state, outputs: [], reason: 'tool_failed', usage };
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  reports = new Map();
  D = Date.now() + 3_600_000;
  ledgerBytes = LEDGERS.cfr96;
  ledgerFault = null;
  answer = prepareAnswer();
  findById.mockResolvedValue(asset);
  createUsageRecorder.mockReturnValue({ recordServiceCall, settle });
  settle.mockResolvedValue(0);
  syncPresentationPins.mockImplementation(async () => { sent.push({ path: 'sync-pins', method: 'CALL', body: null }); });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    if (url.href === RECEIPT.url) {
      sent.push({ path: 'ledger', method, body: null });
      if (ledgerFault === 'reset') throw new TypeError('fetch failed: connection reset');
      if (ledgerFault === 503) return new Response('unavailable', { status: 503 });
      return new Response(ledgerBytes, { headers: { 'content-type': 'application/json' } });
    }
    const path = url.pathname.startsWith('/jobs/') ? '/jobs/read' : url.pathname;
    sent.push({ path, method, body });
    if (path === '/video-presentation') {
      if (body?.action === 'prepare') return Response.json(answer);
      if (body?.action === 'advance_stage' || body?.action === 'report_chunk') return Response.json({ accepted: true });
      // The snapshot carries the DO's readmit fact (required since §93 D6).
      return Response.json({ sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, preparation: null, ledger: null, readmit: false });
    }
    if (path === '/jobs') return Response.json({ schemaVersion: 2, state: 'starting' });
    if (path === '/jobs/read') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const report = reports.get(id);
      return report === undefined ? new Response('missing', { status: 404 }) : Response.json(report);
    }
    return new Response('unexpected', { status: 500 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('each pickup reads the DO once through prepare (inner#1306 §5.1 step 1, E2-3, E2-9)', () => {
  it('ST01 sends prepare with the job identity only: the queue carries no deadline and D comes from the DO', async () => {
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' }, candidateLedger: null });
    await advance()(data);
    expect(actions('prepare')).toEqual([{ action: 'prepare', storageKey: KEY, sourceFingerprint: H, jobId: JOB }]);
  });

  it.each([
    ['a gone row', null],
    ['a deleted row', { ...asset, deletedAt: new Date() }],
    ['a row whose bytes changed', { ...asset, contentHash: 'b'.repeat(64) }],
  ])('ST02 asks ingest nothing for %s', async (_name, row) => {
    findById.mockResolvedValue(row);
    await advance()(data);
    expect(sent).toEqual([]);
  });

  it('ST03 a job the DO does not grant ends without dispatch and without waiting', async () => {
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' }, candidateLedger: null });
    await expect(advance()(data)).resolves.not.toThrow();
    expect(submitted()).toEqual([]);
  });
});

describe('each pickup syncs the candidate and selected pins from the prepare answer (inner#1306 §90 E4-3; design §7.15 唯一写点)', () => {
  it('PS01 hands the job id and the parsed prepare answer to syncPresentationPins once, before any stage or attempt is sent', async () => {
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(syncPresentationPins).toHaveBeenCalledTimes(1);
    expect(syncPresentationPins).toHaveBeenCalledWith(JOB, shared.videoPresentationPrepareAnswerSchema.parse(answer));
    const synced = indexOf((call) => call.path === 'sync-pins');
    expect(synced).toBeGreaterThan(indexOf((call) => call.body?.action === 'prepare'));
    expect(synced).toBeLessThan(indexOf((call) => call.body?.action === 'advance_stage'));
    expect(synced).toBeLessThan(indexOf((call) => call.path === '/jobs' && call.method === 'POST'));
  });

  it('PS02 a job the DO no longer grants still syncs, so its candidate pin is released', async () => {
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' }, candidateLedger: null });
    await advance()(data);
    expect(syncPresentationPins).toHaveBeenCalledWith(JOB, expect.objectContaining({ capability: null, plan: null }));
  });

  it('PS03 a source row that is gone syncs nothing, as it asks ingest nothing', async () => {
    findById.mockResolvedValue(null);
    await advance()(data);
    expect(syncPresentationPins).not.toHaveBeenCalled();
  });
});

describe('dispatch on the frozen standard-4 class with §5.4 identities (inner#1306 §5.1 step 2a, §5.4, §7.17, E2-5)', () => {
  it('DS01 dispatched copy: advance to dispatch_copy, record Sub, then submit the copy attempt 1 and wait', async () => {
    answer = prepareAnswer({ route: 'dispatch_copy' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([expect.objectContaining({ storageKey: KEY, sourceFingerprint: H, jobId: JOB, deadlineAt: D, token: 'token-a', stage: 'dispatch_copy' })]);
    const job = submitted();
    expect(job).toHaveLength(1);
    const id = subJob('copy', 1);
    expect(job[0]).toMatchObject({ jobId: id, containerClass: PRICING.standard4.containerClass, deadlineAt: D });
    const inputs = job[0]!.inputs as { inputId: string; storageKey: string }[];
    expect(inputs).toEqual([{ inputId: expect.any(String), storageKey: KEY }]);
    // §91 D3a: the copy tags the plan's matrix. §94 D8 (design §7.17 copy_carrier row): the answer's copyAudio 'encode'
    // encodes over the stitch's audioOf entries (the display interval with the plan's origin and audio spans).
    expect(job[0]!.outputs).toEqual([expect.objectContaining({ outputIndex: 0, storageKey: workKey(id), recipe: { kind: 'copy_carrier', inputId: inputs[0]!.inputId, colorMatrix: 'bt709', origin: r(0),
      audio: { kind: 'encode', start: r(0), end: r(96, 25), origin: r(0), spans: AUDIO_SPANS } } })]);
    expect(actions('report_chunk')).toEqual([expect.objectContaining({ token: 'token-a', unit: { kind: 'presentation-copy' }, report: { kind: 'Sub' } })]);
    expect(indexOf((call) => call.body?.action === 'report_chunk')).toBeLessThan(indexOf((call) => call.path === '/jobs' && call.method === 'POST'));
  });

  // §94 D8: copyAudio 'copy' (audio inside identity_formats, dispatched only for its size) and null (no audio) reach the recipe as is.
  it.each([
    ['copy', { kind: 'copy' }],
    [null, null],
  ] as const)('DS02 a dispatched copy whose answer names copyAudio %s writes that audio into the recipe', async (copyAudio, audio) => {
    answer = prepareAnswer({ route: 'dispatch_copy', copyAudio });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect((submitted()[0]!.outputs as { recipe: unknown }[])[0]!.recipe).toEqual({ kind: 'copy_carrier', inputId: expect.any(String), colorMatrix: 'bt709', origin: r(0), audio });
  });

  it('DS02 encode: advance to encode and submit one chunk_encode attempt per window, each with its own key', async () => {
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['encode']);
    const jobs = submitted();
    expect(jobs.map((job) => job.jobId)).toEqual([subJob('chunk', 1, 0), subJob('chunk', 1, 1)]);
    // §7.17, §91 D3-1: each window's clip spans from the full ledger, in presentation time, and the plan's target.
    const inputId = (jobs[0]!.inputs as { inputId: string }[])[0]!.inputId;
    expect(jobs.map((job) => (job.outputs as { recipe: unknown }[])[0]!.recipe)).toEqual([
      { kind: 'chunk_encode', inputId, window: { start: 0, end: 48 }, timescale: 25, target: TARGET,
        entries: [{ kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(48, 25), rate: r(1) }] },
      { kind: 'chunk_encode', inputId, window: { start: 48, end: 96 }, timescale: 25, target: TARGET,
        entries: [{ kind: 'source', decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(48, 25), displayEnd: r(96, 25), rate: r(1) }] },
    ]);
    expect(new Set(jobs.map((job) => (job.outputs as { storageKey: string }[])[0]!.storageKey)).size).toBe(2);
    for (const job of jobs) expect(job).toMatchObject({ containerClass: PRICING.standard4.containerClass, deadlineAt: D });
    expect(actions('report_chunk').map((body) => body.unit)).toEqual([{ kind: 'presentation-chunk', chunk: 0 }, { kind: 'presentation-chunk', chunk: 1 }]);
  });

  it('DS03 the full ledger is not ready: nothing is dispatched and the job waits (E2-6)', async () => {
    answer = prepareAnswer({ candidateLedger: { state: 'pending', receipt: null, failure: null } });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([]);
    expect(submitted()).toEqual([]);
  });

  it('DS04 stitch is dispatched only once every chunk is done, over the chunk outputs in order', async () => {
    const units = {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 2, 1), 'done', 'done', 2, true),
    };
    answer = prepareAnswer({ units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['stitch']);
    const jobs = submitted();
    expect(jobs.map((job) => job.jobId)).toEqual([subJob('stitch', 1)]);
    // §91 D3-2: each chunk is a bound input; the stitch carries each chunk's plan duration and the whole interval's audio.
    const inputs = jobs[0]!.inputs as { inputId: string; storageKey: string }[];
    expect(inputs.map((input) => input.storageKey)).toEqual([KEY, workKey(subJob('chunk', 1, 0)), workKey(subJob('chunk', 2, 1))]);
    expect(new Set(inputs.map((input) => input.inputId)).size).toBe(3);
    expect((jobs[0]!.outputs as { recipe: unknown }[])[0]!.recipe).toEqual({ kind: 'stitch', inputId: inputs[0]!.inputId,
      chunks: [{ inputId: inputs[1]!.inputId, duration: r(48, 25) }, { inputId: inputs[2]!.inputId, duration: r(48, 25) }],
      audio: { start: r(0), end: r(96, 25), origin: r(0), spans: AUDIO_SPANS }, target: TARGET });
  });

  it('DS06 every chunk dispatched, one finishing on this pickup and one still running: no advance to stitch and no stitch job', async () => {
    const units = {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'open', 'pending'),
      [`video-presentation:${JOB}:chunk:2`]: unit(subJob('chunk', 1, 2), 'open', 'pending'),
    };
    answer = prepareAnswer({ units, work: { kind: 'encode', chunks: [{ start: 0, end: 32 }, { start: 32, end: 64 }, { start: 64, end: 96 }] },
      preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    reports.set(subJob('chunk', 1, 1), finished(subJob('chunk', 1, 1), 'done', { wallMs: 1000, cpuUsec: 2000 }));
    reports.set(subJob('chunk', 1, 2), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([]);
    expect(submitted().some((job) => String(job.jobId).includes(':stitch:'))).toBe(false);
  });

  it('DS05 one chunk still open: no stitch yet', async () => {
    const units = {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'open', 'pending'),
    };
    answer = prepareAnswer({ units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([]);
    expect(submitted()).toEqual([]);
  });
});

describe('recipes from the full ledger (inner#1306 §91 D3b; design §7.17, §5.4, §4.3)', () => {
  const planOf = (shared as Record<string, unknown>).videoPresentationPlanSha256 as (value: unknown) => Promise<string>;
  const inputOf = (shared as Record<string, unknown>).videoPresentationToolInputId as (value: { sourceFingerprint: string; planSha256: string }) => Promise<string>;

  /**
   * Serve another full ledger as this job's candidate: rebound to this job's source (its toolInputId recomputed), its
   * identity in the answer and the receipt.
   * @param bytes - The ledger bytes.
   * @param fields - What else differs in the answer.
   * @param edit - A change to the plan before it is rebound.
   * @returns Nothing once served.
   */
  async function serve(bytes: Buffer, fields: Record<string, unknown> = {}, edit?: (plan: Record<string, Record<string, unknown>>) => void): Promise<void> {
    const ledger = JSON.parse(bytes.toString('utf8')) as { sourceFingerprint: string; toolInputId: string; planSha256: string; plan: Record<string, Record<string, unknown>> };
    if (edit !== undefined) { edit(ledger.plan); ledger.planSha256 = await planOf(ledger.plan); }
    ledger.sourceFingerprint = H;
    ledger.toolInputId = await inputOf({ sourceFingerprint: H, planSha256: ledger.planSha256 });
    ledgerBytes = Buffer.from(JSON.stringify(ledger));
    bytes = ledgerBytes;
    const base = prepareAnswer(fields);
    answer = { ...base, sourceBinding: { storageKey: KEY, sourceFingerprint: ledger.sourceFingerprint },
      plan: { ...(base.plan as Record<string, unknown>), toolInputId: ledger.toolInputId, planSha256: ledger.planSha256 },
      candidateLedger: { state: 'ready', failure: null, receipt: { ...RECEIPT, sourceFingerprint: ledger.sourceFingerprint, toolInputId: ledger.toolInputId, planSha256: ledger.planSha256,
        attempt: { jobId: JOB, deadlineAt: D }, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } } };
  }

  /**
   * A ledger with the §3.2 item 7 source keyframes (every one, presented or not) and the stream's first packet dts.
   * @param bytes - The ledger bytes.
   * @param keyframes - Each source keyframe's pts and dts.
   * @param firstPacketDts - The first packet's dts.
   * @returns The bytes.
   */
  function withKeyframes(bytes: Buffer, keyframes: { pts: ReturnType<typeof r>; dts: ReturnType<typeof r> }[], firstPacketDts: ReturnType<typeof r>): Buffer {
    const ledger = JSON.parse(bytes.toString('utf8')) as { encoding: Record<string, unknown> };
    return Buffer.from(JSON.stringify({ ...ledger, encoding: { ...ledger.encoding, sourceKeyframes: keyframes, firstPacketDts } }));
  }

  // §93 D6-1 (design §7.17 时间线 row; W7 withdrawn, rounds 3–5): a span decodes from the latest source keyframe whose pts is not
  // after its first frame, presented or not; decodeStart = that keyframe's dts − min(0, firstPacketDts). cut.mp4 (g=10, no
  // B-frames, first packet dts 0) has source keyframes at 0, 0.4, 0.8 and 1.2 s; the first presented frame is source 0.08 s,
  // so the first span decodes from the unpresented keyframe at 0 (was its own first frame time, 2/25).
  it('RB01 an edited source: the first span starts inside its first frame (clipStart at the edit), later chunks at their keyframe', async () => {
    // Reduced times, as the ledger schema requires: 0, 2/5, 4/5 and 6/5 s.
    await serve(withKeyframes(LEDGERS.cut, [r(0), r(2, 5), r(4, 5), r(6, 5)].map((time) => ({ pts: time, dts: time })), r(0)),
      { work: { kind: 'encode', chunks: [{ start: 0, end: 18 }, { start: 18, end: 38 }] } });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    const jobs = submitted();
    const target = { ...TARGET, width: 160, height: 96 };
    const inputId = (jobs[0]!.inputs as { inputId: string }[])[0]!.inputId;
    expect(jobs.map((job) => (job.outputs as { recipe: unknown }[])[0]!.recipe)).toEqual([
      // Presented frame 0 is source 1024/12800 s; the edit starts at 1/10 s, so it shows from there for 1/50 s (§91 D3b-4).
      { kind: 'chunk_encode', inputId, window: { start: 0, end: 18 }, timescale: 50, target,
        entries: [{ kind: 'source', decodeStart: r(0), clipStart: r(1, 10), displayStart: r(0), displayEnd: r(7, 10), rate: r(1) }] },
      { kind: 'chunk_encode', inputId, window: { start: 18, end: 38 }, timescale: 50, target,
        entries: [{ kind: 'source', decodeStart: r(4, 5), clipStart: r(4, 5), displayStart: r(7, 10), displayEnd: r(3, 2), rate: r(1) }] },
    ]);
  });

  // §91 D3b-6: the plan sets `emptyFill: 'transparent'` exactly when the probe confirmed alpha (presentation-run.ts policy), and it is inside planSha256.
  it('RB02 a transparent source is encoded alpha-packed: the target is two even planes side by side with a 4-column gap', async () => {
    await serve(LEDGERS.cfr96, {}, (plan) => { plan.policy!.emptyFill = 'transparent'; });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    const recipes = submitted().map((job) => (job.outputs as { recipe: { target: unknown } }[])[0]!.recipe);
    expect(recipes.map((recipe) => recipe.target)).toEqual([0, 1].map(() => ({ ...TARGET, width: 644, height: 180, alpha: 'packed' })));
  });

  it.each([
    ['bytes that are not the receipt\'s', false, (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.from(' ')])],
    ['a ledger of another toolInputId than the plan the DO answered', true, (bytes: Buffer): Buffer => {
      const ledger = JSON.parse(bytes.toString('utf8')) as { toolInputId: string };
      return Buffer.from(JSON.stringify({ ...ledger, toolInputId: 'e'.repeat(64) }));
    }],
  ] as const)('RB03 a full ledger with %s builds nothing: no chunk is submitted', async (_name, remeasure, change) => {
    await serve(LEDGERS.cfr96);
    ledgerBytes = change(ledgerBytes);
    if (remeasure) {
      const ready = answer.candidateLedger as { receipt: Record<string, unknown> };
      ready.receipt = { ...ready.receipt, size: ledgerBytes.byteLength, sha256: createHash('sha256').update(ledgerBytes).digest('hex') };
    }
    await advance()(data).catch(() => undefined);
    expect(submitted()).toEqual([]);
  });

  // §91 D3b-9 (design §7.4 `Check`: a ready ledger with a real physical mismatch moves to failed-transient, and §7.1 `Lt`
  // starts the automatic ledgerOnly repair): the worker asks the DO to check (the `read` action runs Check against R2) and
  // waits for the repaired receipt, instead of failing every pickup until the deadline.
  it('RB05 a full ledger that fails its receipt makes the pickup ask the DO to check it, submit nothing and wait', async () => {
    await serve(LEDGERS.cfr96);
    ledgerBytes = Buffer.concat([ledgerBytes, Buffer.from(' ')]);
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(submitted()).toEqual([]);
    expect(actions('read')).toEqual([expect.objectContaining({ storageKey: KEY, sourceFingerprint: H, targetPolicyVersion: 1 })]);
    // The catch that turns the mismatch into a wait logs it with the toolInputId the ledger failed for.
    const toolInputId = (answer.plan as { toolInputId: string }).toolInputId;
    expect([...logger.warn.mock.calls, ...logger.error.mock.calls]).toContainEqual([expect.objectContaining({ ctx: expect.objectContaining({ toolInputId }) }), expect.any(String)]);
  });

  // §91 D3b-9: a transport failure is not a content mismatch: no Check is asked for and the pickup keeps its normal
  // transient retry; once the read succeeds the chunks are dispatched.
  it.each([['a connection reset', 'reset'], ['a 503 before any body', 503]] as const)('RB06 %s reading the full ledger asks for no check, submits nothing and retries', async (_name, fault) => {
    await serve(LEDGERS.cfr96);
    ledgerFault = fault;
    await expect(advance()(data)).rejects.toBeDefined();
    expect(actions('read')).toEqual([]);
    expect(actions('fail')).toEqual([]);
    expect(submitted()).toEqual([]);
    ledgerFault = null;
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(submitted()).toHaveLength(2);
  });

  // ---- Cases that each fail on one deletion mutation of the D3b builder (inner#1306 §91 D3b mutations) ----

  /**
   * A chunk window's recipe entries from the submitted jobs.
   * @returns Each job's entries.
   */
  function entriesSubmitted(): Record<string, unknown>[][] {
    return submitted().map((job) => (job.outputs as { recipe: { entries: Record<string, unknown>[] } }[])[0]!.recipe.entries);
  }

  it('RB07 a ledger whose content differs from its receipt at the same length (digest only) is a content mismatch: read, nothing submitted, wait', async () => {
    await serve(LEDGERS.cfr96);
    const text = ledgerBytes.toString('utf8');
    const swapped = text.replace('"deadlineAt":1900000000000', '"deadlineAt":1900000000001');
    expect(swapped).not.toBe(text);
    ledgerBytes = Buffer.from(swapped);
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(submitted()).toEqual([]);
    expect(actions('read')).toHaveLength(1);
  });

  it('RB08 an invalid full ledger moves no stage and reports no Sub for any unit (§91 D3b-9 「不提交」)', async () => {
    await serve(LEDGERS.cfr96);
    ledgerBytes = Buffer.concat([ledgerBytes, Buffer.from(' ')]);
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([]);
    expect(actions('report_chunk').filter((body) => (body.report as { kind: string }).kind === 'Sub')).toEqual([]);
  });

  it('RB10 a window over two video edits gives one source entry per edit, each with its own clip start (§7.17)', async () => {
    await serve(LEDGERS.cut, { work: { kind: 'encode', chunks: [{ start: 0, end: 38 }] } }, (plan) => {
      plan.videoSpans = [
        { sourceStart: r(1, 10), sourceEnd: r(4, 5), presentationStart: r(0), rate: r(1) },
        { sourceStart: r(4, 5), sourceEnd: r(8, 5), presentationStart: r(7, 10), rate: r(1) },
      ] as unknown as Record<string, unknown>;
    });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    // §93 (design §7.17 时间线 row, rounds 3–5, user 2026-11-05): the first span decodes from the unpresented source keyframe
    // at 0 (cut.mp4 has no B-frames and its first packet dts is 0), so its decodeStart is that keyframe's dts, 0.
    expect(entriesSubmitted()).toEqual([[
      { kind: 'source', decodeStart: r(0), clipStart: r(1, 10), displayStart: r(0), displayEnd: r(7, 10), rate: r(1) },
      { kind: 'source', decodeStart: r(4, 5), clipStart: r(4, 5), displayStart: r(7, 10), displayEnd: r(3, 2), rate: r(1) },
    ]]);
  });

  it('RB11 a derived-empty frame of a transparent plan is a transparent empty entry', async () => {
    await serve(LEDGERS.cfr96, {}, (plan) => {
      plan.policy!.emptyFill = 'transparent';
      const mapping = plan.originMapping as unknown as { entries: unknown[]; lastSource: { supportEnd: unknown } };
      mapping.entries = [{ kind: 'source', start: 0, count: 95, step: 1 }, { kind: 'derived-empty' }];
      mapping.lastSource.supportEnd = r(19, 5);
    });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(entriesSubmitted()[1]!.at(-1)).toEqual({ kind: 'empty', fill: 'transparent', window: { start: r(19, 5), end: r(96, 25) } });
  });

  it('RB12 a plan with a non-zero origin: the stitch audio carries that origin (§91 D3b-11)', async () => {
    const units = {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'done', 'done', 1, true),
    };
    await serve(LEDGERS.cfr96, { units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } }, (plan) => {
      (plan.originMapping as unknown as { origin: unknown }).origin = r(1, 4);
    });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect((submitted()[0]!.outputs as { recipe: { audio: { origin: unknown } } }[])[0]!.recipe.audio.origin).toEqual(r(1, 4));
  });

  it('RB13 the copy of a plan whose matrix is BT.601 tags BT.601', async () => {
    await serve(LEDGERS.cfr96, { route: 'dispatch_copy' }, (plan) => { (plan as unknown as { colorMatrix: string }).colorMatrix = 'bt601'; });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect((submitted()[0]!.outputs as { recipe: unknown }[])[0]!.recipe).toMatchObject({ kind: 'copy_carrier', colorMatrix: 'bt601' });
  });

  // §91 D3b-7 / W1 decision (design E2-6, §5.3 validatedFullLedger): a job reads only its candidate's own ledger. The
  // selected version's ledger is either that same ledger (same toolInputId) or another plan's, so there is no fallback:
  // while the candidate's ledger is not ready the pickup only waits. It reads nothing, asks the DO nothing, logs no
  // error, reports nothing and submits nothing, even with an open attempt to settle.
  it.each([
    ['pending', { state: 'pending', receipt: null, failure: null }],
    ['failed', { state: 'failed', receipt: null, failure: 'source_ledger_invalid' }],
  ] as const)('RB14 a candidate ledger that is %s, beside a selected version of another plan with a ready ledger: the pickup only waits', async (_name, candidateLedger) => {
    const selected = {
      schemaVersion: 1, sourceFingerprint: H, versionId: 'e'.repeat(64), toolInputId: T, planSha256: PLAN, policyVersion: 1, producerVersion: 2, profileVersion: 1,
      original: { width: 320, height: 180, duration: 3.84 }, display: { width: 320, height: 180, duration: r(96, 25) },
      playback: { kind: 'native', carrier: { storageKey: `${KEY}.carrier.mp4`, url: `https://assets.example.test/${KEY}.carrier.mp4`, etag: '"c"', size: 4096, sha256: 'c'.repeat(64), contentType: 'video/mp4' }, displayRect: null },
      playbackClock: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 96, step: 1, duration: 1 }] },
    };
    answer = prepareAnswer({
      presentation: selected, ledger: { state: 'ready', receipt: { ...RECEIPT, attempt: { jobId: 'video-presentation-selected', deadlineAt: D } }, failure: null },
      plan: { route: 'encode', stages: STAGES.encode, toolInputId: 'e'.repeat(64), planSha256: 'f'.repeat(64) },
      candidateLedger,
      preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null },
      units: { [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'open', 'pending') },
    });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(sent.filter((call) => call.path === 'ledger')).toEqual([]);
    expect(sent.filter((call) => call.path === '/jobs' || call.path === '/jobs/read')).toEqual([]);
    expect(actions('report_chunk')).toEqual([]);
    expect(actions('read')).toEqual([]);
    expect([...logger.error.mock.calls, ...logger.warn.mock.calls]).toEqual([]);
  });

  // S6d D4-1 (design §3 line 172): a video edit at rate 2 is processed by its declaration. The ledger is cfr96 with its edit
  // at rate 2 and a presentation table that matches (96 frames of 1/50 s, display 48/25 s); the entries carry the rate
  // and their clip starts are the source times the spans map each window start to. Both windows start on a keyframe (0, 48),
  // so the open decodeStart choice (§91 W7) does not change them.
  it('RB15 a video edit at rate 2 gives entries at rate 2 whose clip starts are the mapped source times', async () => {
    await serve(LEDGERS.cfr96, {}, (plan) => {
      (plan as unknown as { videoSpans: unknown }).videoSpans = [{ sourceStart: r(0), sourceEnd: r(96, 25), presentationStart: r(0), rate: r(2) }];
      (plan as unknown as { presentation: unknown }).presentation = { schemaVersion: 1, timescale: 50, runs: [{ start: 0, count: 96, step: 1, duration: 1 }] };
      (plan.display as unknown as { duration: unknown }).duration = r(48, 25);
      (plan.originMapping as unknown as { lastSource: { supportEnd: unknown } }).lastSource.supportEnd = r(48, 25);
    });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(entriesSubmitted()).toEqual([
      [{ kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(24, 25), rate: r(2) }],
      [{ kind: 'source', decodeStart: r(48, 25), clipStart: r(48, 25), displayStart: r(24, 25), displayEnd: r(48, 25), rate: r(2) }],
    ]);
    expect(submitted().map((job) => (job.outputs as { recipe: { timescale: number } }[])[0]!.recipe.timescale)).toEqual([50, 50]);
  });

  // §93 D6-1 (design §7.17 时间线 row; the W7 expectation of 757961b87 is withdrawn): a window starting mid-GOP decodes from the
  // latest source keyframe not after its first frame. cfr96 (no B-frames, first packet dts 0) has keyframes at 0 and 48/25 s.
  it('RB16 a window starting mid-GOP: decodeStart is the preceding source keyframe\'s dts, not its first frame\'s source time', async () => {
    await serve(withKeyframes(LEDGERS.cfr96, [{ pts: r(0), dts: r(0) }, { pts: r(48, 25), dts: r(48, 25) }], r(0)),
      { work: { kind: 'encode', chunks: [{ start: 0, end: 10 }, { start: 10, end: 96 }] } });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(entriesSubmitted()[1]).toEqual([{ kind: 'source', decodeStart: r(0), clipStart: r(2, 5), displayStart: r(2, 5), displayEnd: r(96, 25), rate: r(1) }]);
  });

  it('RB04 a done packed stitch is reported Done with its alpha-packed carrier and the geometry the job reported, and no manifest (§91 D3-3)', async () => {
    const id = subJob('stitch', 1);
    const units: Record<string, Unit> = { [`video-presentation:${JOB}:stitch`]: unit(id, 'open', 'pending'),
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true), [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'done', 'done', 1, true) };
    answer = prepareAnswer({ units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'stitch', failure: null } });
    const geometry = { packedWidth: 640, packedHeight: 180, colorRect: { x: 0, y: 0, width: 320, height: 180 }, alphaRect: { x: 320, y: 0, width: 320, height: 180 } };
    const report = finished(id, 'done', { wallMs: 5000, cpuUsec: 20_000_000 }) as { outputs: Record<string, unknown>[] };
    report.outputs[0] = { ...report.outputs[0], packing: geometry };
    reports.set(id, report);
    await advance()(data).catch(() => undefined);
    const done = actions('report_chunk').find((body) => (body.report as { kind: string }).kind === 'Done');
    expect((done!.report as { receipts: unknown }).receipts).toEqual([{ role: 'carrier', packing: 'alpha-packed', storageKey: workKey(id), sha256: 'f'.repeat(64), sizeBytes: 100, contentType: 'video/mp4', geometry }]);
  });
});

describe('publish is the DO\'s: the worker forwards receipts and advances (inner 54ce9ea3 §5.1 step 4)', () => {
  /**
   * Whether any request sent a bundle to ingest.
   * @returns True when one did.
   */
  function sentBundle(): boolean {
    return actions('report').some((body) => (body.fact as { kind?: string } | undefined)?.kind === 'verified');
  }

  it.each([
    ['dispatched copy', 'dispatch_copy', { [`video-presentation:${JOB}:copy`]: unit(subJob('copy', 1), 'done', 'done', 1, true) }],
    ['stitch', 'encode', {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:stitch`]: unit(subJob('stitch', 1), 'done', 'done', 1, true),
    }],
  ] as const)('PU01 after a done %s the worker advances to publish and never sends a bundle', async (_name, route, units) => {
    answer = prepareAnswer({ route, units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: route === 'encode' ? 'stitch' : 'dispatch_copy', failure: null } });
    await advance()(data).catch(() => undefined);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['publish']);
    expect(submitted()).toEqual([]);
    expect(sentBundle()).toBe(false);
  });

  it.each([
    ['copy', 'dispatch_copy', 'presentation-copy'],
    ['stitch', 'encode', 'presentation-stitch'],
  ] as const)('PU02 a done %s attempt is reported Done with the job DO\'s measured receipts, its carrier tagged', async (kind, route, unitKind) => {
    const id = subJob(kind, 1);
    const units: Record<string, Unit> = { [`video-presentation:${JOB}:${kind}`]: unit(id, 'open', 'pending') };
    if (route === 'encode') {
      units[`video-presentation:${JOB}:chunk:0`] = unit(subJob('chunk', 1, 0), 'done', 'done', 1, true);
      units[`video-presentation:${JOB}:chunk:1`] = unit(subJob('chunk', 1, 1), 'done', 'done', 1, true);
    }
    answer = prepareAnswer({ route, units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: route === 'encode' ? 'stitch' : 'dispatch_copy', failure: null } });
    reports.set(id, finished(id, 'done', { wallMs: 5000, cpuUsec: 20_000_000 }));
    await advance()(data).catch(() => undefined);
    const done = actions('report_chunk').find((body) => (body.report as { kind: string }).kind === 'Done');
    expect(done).toMatchObject({ unit: { kind: unitKind }, report: { kind: 'Done', attempt: 1,
      // §90 E4-15: the role-tagged list of the job's outputs; a one-output job wrote a native carrier.
      receipts: [{ role: 'carrier', packing: 'native', storageKey: workKey(id), sha256: 'f'.repeat(64), sizeBytes: 100, contentType: 'video/mp4' }] } });
    expect(sentBundle()).toBe(false);
  });
});

describe('attempt results, retries and usage (inner#1306 §7.1.1, §7.6, E2-7)', () => {
  const inFlight = (): Record<string, unknown> => prepareAnswer({
    units: { [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'open', 'pending'), [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'open', 'pending') },
    preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null },
  });

  it('AT01 a done attempt is reported Done, its usage recorded once as a platform expense keyed by its job id at the frozen standard-4 price, then Rec', async () => {
    answer = inFlight();
    const usage = { wallMs: 90_000, cpuUsec: 300_000_000 };
    reports.set(subJob('chunk', 1, 0), finished(subJob('chunk', 1, 0), 'done', usage));
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    const chunkReports = actions('report_chunk').filter((body) => (body.unit as { chunk?: number }).chunk === 0).map((body) => body.report as { kind: string; attempt?: number });
    expect(chunkReports.map((report) => report.kind)).toEqual(['Done', 'Rec']);
    expect(chunkReports.every((report) => report.attempt === 1)).toBe(true);
    expect(createUsageRecorder).toHaveBeenCalledTimes(1);
    expect(createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ operationKey: subJob('chunk', 1, 0), multiplier: 0, actorUserId: ACTOR, projectId: null }));
    expect(recordServiceCall).toHaveBeenCalledWith(expect.objectContaining({ source: 'container',
      costUsd: containerCostUsd(usage, PRICING.standard4.size, PRICING.standard4.prices), costSource: 'computed' }));
    const rec = indexOf((call) => call.body?.action === 'report_chunk' && (call.body.report as { kind: string }).kind === 'Rec');
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan((vi.mocked(fetch).mock.invocationCallOrder[rec])!);
  });

  it('AT02 an ended attempt whose container reported no CPU time is recorded at its provisioned vCPU over its wall time', async () => {
    answer = inFlight();
    const usage = { wallMs: 90_000, cpuUsec: null };
    reports.set(subJob('chunk', 1, 0), finished(subJob('chunk', 1, 0), 'done', usage));
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(recordServiceCall).toHaveBeenCalledWith(expect.objectContaining({ costUsd: containerCostUsd(usage, PRICING.standard4.size, PRICING.standard4.prices) }));
    expect(actions('report_chunk').some((body) => (body.report as { kind: string }).kind === 'Rec')).toBe(true);
  });

  it('AT03 a failed attempt is reported Fail with its reason and measured usage', async () => {
    answer = inFlight();
    reports.set(subJob('chunk', 1, 0), finished(subJob('chunk', 1, 0), 'failed', { wallMs: 1000, cpuUsec: 2000 }));
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    const fail = actions('report_chunk').find((body) => (body.report as { kind: string }).kind === 'Fail');
    expect(fail).toMatchObject({ unit: { kind: 'presentation-chunk', chunk: 0 }, report: { kind: 'Fail', attempt: 1, code: 'tool_failed' } });
  });

  it('AT04 the DO opened the next attempt: it is submitted under its own §5.4 id and key, never the old one', async () => {
    const retried: Unit = { state: 'open', attempt: 2, attempts: [
      { attempt: 1, jobId: subJob('chunk', 1, 0), state: 'failed', usageRecorded: true },
      { attempt: 2, jobId: subJob('chunk', 2, 0), state: 'pending', usageRecorded: false },
    ] };
    answer = prepareAnswer({ units: { [`video-presentation:${JOB}:chunk:0`]: retried, [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'done', 'done', 1, true) },
      preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    const jobs = submitted();
    expect(jobs.map((job) => job.jobId)).toEqual([subJob('chunk', 2, 0)]);
    expect((jobs[0]!.outputs as { storageKey: string }[])[0]!.storageKey).toBe(workKey(subJob('chunk', 2, 0)));
    expect(workKey(subJob('chunk', 2, 0))).not.toBe(workKey(subJob('chunk', 1, 0)));
  });

  it('AT05 a failed candidate dispatches nothing more and does not wait', async () => {
    answer = prepareAnswer({ preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: 'tool_failed' },
      units: { [`video-presentation:${JOB}:chunk:0`]: { state: 'failed', attempt: 4, attempts: [1, 2, 3, 4].map((attempt) => ({ attempt, jobId: subJob('chunk', attempt, 0), state: 'failed', usageRecorded: true })) } } });
    await expect(advance()(data)).resolves.not.toThrow();
    expect(submitted()).toEqual([]);
    expect(actions('advance_stage')).toEqual([]);
  });

  it('AT06 a failed candidate records its ended attempt\'s usage before the job ends', async () => {
    answer = prepareAnswer({ preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: 'tool_failed' },
      units: { [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'failed', 'failed') } });
    reports.set(subJob('chunk', 1, 0), finished(subJob('chunk', 1, 0), 'failed', { wallMs: 1000, cpuUsec: null }));
    await expect(advance()(data)).resolves.not.toThrow();
    expect(actions('report_chunk').some((body) => (body.report as { kind: string }).kind === 'Rec')).toBe(true);
  });

  it('AT06c an ended attempt whose report read starts 1 ms before the reporting window ends still records its usage', async () => {
    // The window ends at D + 2 polls (poll_interval_ms 5000 above). The clock stands 1 ms before it while the pickup runs; each
    // read takes 20 ms of real time and moves the clock with it, and, like fetch, stops when its signal aborts.
    D = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(D + 10_000 - 1);
    try {
      answer = prepareAnswer({ preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: 'tool_failed' },
        units: { [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'failed', 'failed') } });
      reports.set(subJob('chunk', 1, 0), finished(subJob('chunk', 1, 0), 'failed', { wallMs: 1000, cpuUsec: null }));
      const served = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
        if (url.pathname.startsWith('/jobs/')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          vi.setSystemTime(Date.now() + 20);
          init?.signal?.throwIfAborted();
        }
        return served(input, init);
      });
      await expect(advance()(data)).resolves.not.toThrow();
      expect(actions('report_chunk').some((body) => (body.report as { kind: string }).kind === 'Rec')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AT06b an ended attempt whose usage is unknown (its container never started or vanished unmeasured) holds nothing back and records nothing', async () => {
    answer = prepareAnswer({ preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: 'tool_failed' },
      units: { [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'failed', 'failed') } });
    reports.set(subJob('chunk', 1, 0), finished(subJob('chunk', 1, 0), 'failed', null));
    await expect(advance()(data)).resolves.not.toThrow();
    expect(createUsageRecorder).not.toHaveBeenCalled();
  });

  it('AT07 the basic execution\'s own usage is recorded once under `video-presentation:<jobId>` at multiplier 0 and acknowledged after it settles', async () => {
    const usageFact = { jobId: JOB, actorUserId: ACTOR, projectId: null, usage: { wallMs: 4200, cpuUsec: 1_000_000 }, pricing: PRICING.basic };
    answer = prepareAnswer({ route: 'identity', usageFact, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'plan', failure: null } });
    await advance()(data).catch(() => undefined);
    expect(createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ operationKey: `video-presentation:${JOB}`, multiplier: 0, actorUserId: ACTOR }));
    expect(recordServiceCall).toHaveBeenCalledWith(expect.objectContaining({ costUsd: containerCostUsd(usageFact.usage, PRICING.basic.size, PRICING.basic.prices) }));
    const ack = actions('ack_usage');
    expect(ack).toEqual([expect.objectContaining({ storageKey: KEY, sourceFingerprint: H, jobId: JOB, deadlineAt: D })]);
  });
});

describe('usage invariant over any measurement (inner#1306 §7.6, §7.1.1 Rec; critical path)', () => {
  it('AT08 for any measured usage of a done attempt, one record at multiplier 0 keyed by that attempt at the frozen standard-4 price, then Rec', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 7_200_000 }), fc.integer({ min: 0, max: 28_800_000_000 }), fc.integer({ min: 1, max: 4 }),
      async (wallMs, cpuUsec, attempt) => {
        sent = [];
        reports = new Map();
        createUsageRecorder.mockClear();
        recordServiceCall.mockClear();
        const id = subJob('chunk', attempt, 0);
        answer = prepareAnswer({ units: { [`video-presentation:${JOB}:chunk:0`]: unit(id, 'open', 'pending', attempt), [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'done', 'done', 1, true) },
          preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
        reports.set(id, finished(id, 'done', { wallMs, cpuUsec }));
        await advance()(data).catch(() => undefined);
        expect(createUsageRecorder).toHaveBeenCalledTimes(1);
        expect(createUsageRecorder.mock.calls[0]![0]).toMatchObject({ operationKey: id, multiplier: 0 });
        expect(recordServiceCall).toHaveBeenCalledTimes(1);
        expect(recordServiceCall.mock.calls[0]![0]).toMatchObject({ costUsd: containerCostUsd({ wallMs, cpuUsec }, PRICING.standard4.size, PRICING.standard4.prices) });
        expect(actions('report_chunk').filter((body) => (body.report as { kind: string }).kind === 'Rec')).toEqual([expect.objectContaining({ report: { kind: 'Rec', attempt } })]);
      },
    ), { numRuns: 40 });
  });
});

describe('the deadline bounds the job (inner#1306 §5.1 step 1, §5.4 预算, E2-6)', () => {
  it('DL01 at D with work in flight the job fails `expired` and submits nothing new', async () => {
    D = Date.now() - 1;
    answer = prepareAnswer({ units: { [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'open', 'pending') },
      preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    await advance()(data).catch(() => undefined);
    expect(actions('fail')).toEqual([expect.objectContaining({ storageKey: KEY, sourceFingerprint: H, jobId: JOB, deadlineAt: D, code: 'expired' })]);
    expect(submitted()).toEqual([]);
  });

  it('DL02 waiting on a ledger that is not ready ends at D as `expired`', async () => {
    D = Date.now() - 1;
    answer = prepareAnswer({ candidateLedger: { state: 'pending', receipt: null, failure: null } });
    await advance()(data).catch(() => undefined);
    expect(actions('fail')).toEqual([expect.objectContaining({ code: 'expired' })]);
  });
});
