// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The worker's staged presentation job on the frame grid (inner#1306 frames-split design §5.1 steps 1, 2 and 2a, §5.4
 * 作业身份, §7.1, §7.1.1, §7.6, §7.17; interface choices E2-3 to E2-7 and E2-9).
 *
 * One durable job per presentation jobId, following `advance-plan-job.ts`: each pickup reads the DO once through `prepare`
 * (D comes only from its capability) and the `/jobs` state of the attempts it knows, submits only the next allowed stage or
 * attempt along the route's stages (count, edit chunks, edit stitch, playback chunks, stitch, publish), and throws
 * StillRunning while work is in flight. Sub-jobs run on the frozen standard-4 class with §5.4 job ids and the shared key
 * function; each attempt's usage is recorded once as a platform expense keyed by its full job id, then marked with
 * `report_chunk Rec`. At D the job fails `expired`. The ingest boundary is faked at `fetch`.
 *
 * Each unit's recipe is written by the real `frozen-plan-facts.ts` from the plan and probe facts the prepare answer carries
 * for this 320x180, 25 fps, 96-frame source (§5.1 2a row, §7.17); a done count job reports its count (§7.17 grid_count).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DelayedError } from 'bullmq';
import * as shared from '@breatic/shared';
import { videoContainerJobId, videoCarrierRouteStages } from '@breatic/shared/mini-tools';
import type * as coreModule from '@breatic/core';
import { containerCostUsd } from '@breatic/domain';
import { getNodeTaskConfig } from '@breatic/core';
import * as handler from '@worker/handlers/video-presentation.js';
import { StillRunning } from '@worker/handlers/still-running.js';
import { chunkInputId, SOURCE_INPUT_ID } from '@worker/handlers/video-presentation-recipes.js';
import { frozenVersion, planDigest } from '@worker/handlers/mini-tool/__tests__/frozen-presentation.js';

const { findById, createUsageRecorder, recordServiceCall, settle, syncPresentationPins, logger, listProjectsReferencingStorageKey, publishVideoPresentationChanged, redisStore, redisGet, redisSet } = vi.hoisted(() => ({
  findById: vi.fn(), createUsageRecorder: vi.fn(), recordServiceCall: vi.fn(), settle: vi.fn(), syncPresentationPins: vi.fn(),
  listProjectsReferencingStorageKey: vi.fn(), publishVideoPresentationChanged: vi.fn(),
  // The Redis keys the handler keeps, in memory, and its calls.
  redisStore: new Map<string, string>(),
  redisGet: vi.fn(), redisSet: vi.fn(),
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
    getStorageAdapter: async () => ({ publicUrl: (key: string): string => `https://assets.example.test/${key}` }),
    publishVideoPresentationChanged,
    getRedis: () => ({ get: redisGet, set: redisSet }),
  };
});
vi.mock('@breatic/domain', async (original) => ({
  ...await original<Record<string, unknown>>(),
  assetRepo: { findById, listProjectsReferencingStorageKey },
  createUsageRecorder,
  // S6e E4-3: the domain function that writes candidate and selected pins from the prepare answer.
  syncPresentationPins,
}));

const H = 'd'.repeat(64);
const T = 'e989392b50af768e7d1a42bdf29921f364c87e90bdb34ddc633209ffe22a19ec';
const KEY = 'video/canonical.webm';
const JOB = 'video-presentation-a';
const ACTOR = '6061c056-f758-47c1-9527-8495ecba60e3';
const asset = { id: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: H, storageKey: KEY, kind: 'video', deletedAt: null, mimeType: 'video/webm' };
const data = { assetId: asset.id, sourceFingerprint: H, jobId: JOB };
const price = (containerClass: string, vcpu: number, memory: number, disk: number): { containerClass: string; size: { vcpu: number; memory_gib: number; disk_gb: number }; prices: { vcpu_second_usd: number; memory_gib_second_usd: number; disk_gb_second_usd: number } } => ({
  containerClass, size: { vcpu, memory_gib: memory, disk_gb: disk }, prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.000003, disk_gb_second_usd: 0.0000001 },
});
const PRICING = { basic: price('MediaContainer', 0.25, 1, 4), standard4: price('MiniToolContainerStd4', 4, 12, 20) };
// The plan and probe facts of a 320x180, 25 fps, 96-frame original with audio, opaque, BT.709, the first edit tier.
const ZERO = { numerator: 0, denominator: 1 };
const FPS = { numerator: 25, denominator: 1 };
const CONTENT = {
  gridRulesVersion: 1, grid: { fps: FPS, gridStart: ZERO, leadFrames: 0, gridEnd: { numerator: 96, denominator: 25 }, singleFrameDurationMs: 5000 },
  toolSource: 'original' as 'original' | 'edit', audioTrack: 0, display: { width: 320, height: 180 }, color: { matrix: 'bt709', toneMap: 'none' as const }, framePngBitDepth: 8 as const,
};
const DISPLAY = { width: 320, height: 180, fps: FPS, frameCount: 96, gridStart: ZERO, realFrameCount: 96, leadFrames: 0, holdFrames: 0 };
const SOURCE_FACTS = { color: { matrix: 'bt709', transfer: 'bt709', primaries: 'bt709', range: 'tv', chromaLocation: 'left' },
  keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1.92, allKeyframes: false }, alpha: false };
const EDIT_KEY = `${KEY}.edit.mp4`;
const TIER = 'edit_h264_intra_8bit_420' as const;
const COUNT = { lastVideoTime: { numerator: 95, denominator: 25 }, sourceFrames: 96 };

type Route = 'encode' | 'edit' | 'reuse_edit' | 'reuse';
interface Sent { path: string; method: string; body: Record<string, unknown> | null }
let sent: Sent[] = [];
let answer: Record<string, unknown>;
let reports: Map<string, Record<string, unknown>>;
let D: number;

type Unit = { state: string; attempt: number; attempts: { attempt: number; jobId: string; state: string; usageRecorded: boolean }[] };

/**
 * A worker-only prepare answer.
 * @param fields - What differs from a granted encode job at its plan stage.
 * @returns It.
 */
function prepareAnswer(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const route = (fields.route as Route | undefined) ?? 'encode';
  const { route: _route, ...rest } = fields;
  const chunks = [{ start: 0, end: 48 }, { start: 48, end: 96 }];
  return {
    sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null,
    preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'plan', failure: null },
    capability: { token: 'token-a', deadlineAt: D },
    plan: plannedFacts(route),
    work: route === 'reuse' ? { kind: 'none' } : route === 'edit' ? { kind: 'edit', editChunks: [{ start: 0, end: 32 }, { start: 32, end: 64 }, { start: 64, end: 96 }], chunks } : { kind: 'encode', chunks },
    units: {},
    // §91 D3b-1: the carrier and edit-file encode parameters frozen at admission.
    frozen: { pricing: PRICING, actorUserId: ACTOR, projectId: null, carrier: { crf: 18, preset: 'medium', maxShortSide: 1080 }, edit: { crf: 15, preset: 'medium' } },
    ...rest,
  };
}

/**
 * The plan part of a granted answer: the route, the plan object under its own digest and the probe facts (§5.1 2a row).
 * @param route - The route.
 * @returns It.
 */
function plannedFacts(route: Route): Record<string, unknown> {
  const edit = route === 'edit' || route === 'reuse_edit';
  const content = { ...CONTENT, toolSource: edit ? 'edit' as const : 'original' as const };
  return {
    route, stages: videoCarrierRouteStages(route), toolInputId: route === 'edit' ? null : T, planSha256: planDigest(content), content, display: DISPLAY,
    source: { ...SOURCE_FACTS, editTier: edit ? TIER : null }, editStorageKey: route === 'reuse_edit' ? EDIT_KEY : null,
  };
}

/**
 * The §5.4 id of one presentation sub-job attempt.
 * @param kind - The unit kind.
 * @param attempt - The attempt number.
 * @param chunk - The chunk index for chunks.
 * @returns The job id.
 */
function subJob(kind: 'chunk' | 'stitch' | 'count' | 'edit' | 'edit-stitch', attempt: number, chunk = 0): string {
  if (kind === 'chunk') return videoContainerJobId({ kind: 'presentation-chunk', jobId: JOB, chunk, attempt });
  if (kind === 'edit') return videoContainerJobId({ kind: 'presentation-edit', jobId: JOB, chunk, attempt });
  return videoContainerJobId({ kind: kind === 'stitch' ? 'presentation-stitch' : kind === 'count' ? 'presentation-count' : 'presentation-edit-stitch', jobId: JOB, attempt });
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
  // A count job writes no object and reports its count (§7.17 grid_count).
  const counting = [1, 2, 3, 4].some((attempt) => subJob('count', attempt) === jobId);
  if (state !== 'done') return { schemaVersion: 2, state, outputs: [], reason: 'tool_failed', usage };
  return counting ? { schemaVersion: 2, state, outputs: [], usage, count: COUNT } : { schemaVersion: 2, state, outputs: [output], usage };
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  reports = new Map();
  D = Date.now() + 3_600_000;
  answer = prepareAnswer();
  findById.mockResolvedValue(asset);
  listProjectsReferencingStorageKey.mockResolvedValue([]);
  redisStore.clear();
  redisGet.mockReset().mockImplementation(async (key: string): Promise<string | null> => redisStore.get(key) ?? null);
  redisSet.mockReset().mockImplementation(async (key: string, value: string): Promise<'OK'> => { redisStore.set(key, value); return 'OK'; });
  createUsageRecorder.mockReturnValue({ recordServiceCall, settle });
  settle.mockResolvedValue(0);
  syncPresentationPins.mockImplementation(async () => { sent.push({ path: 'sync-pins', method: 'CALL', body: null }); });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    const path = url.pathname.startsWith('/jobs/') ? '/jobs/read' : url.pathname;
    sent.push({ path, method, body });
    if (path === '/video-presentation') {
      if (body?.action === 'prepare') return Response.json(answer);
      if (body?.action === 'advance_stage' || body?.action === 'report_chunk' || body?.action === 'record_chunk_usage') return Response.json({ accepted: true });
      // The snapshot carries the DO's readmit fact (required since §93 D6).
      return Response.json({ sourceBinding: { storageKey: KEY, sourceFingerprint: H }, presentation: null, preparation: null, readmit: false });
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
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' } });
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
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' } });
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
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' } });
    await advance()(data);
    expect(syncPresentationPins).toHaveBeenCalledWith(JOB, expect.objectContaining({ capability: null, plan: null }));
  });

  it('PS03 a source row that is gone syncs nothing, as it asks ingest nothing', async () => {
    findById.mockResolvedValue(null);
    await advance()(data);
    expect(syncPresentationPins).not.toHaveBeenCalled();
  });
});

describe('dispatch along the route on the frozen standard-4 class with §5.4 identities (§5.1 step 2a, §5.4, §7.1.1, §7.17, E2-5)', () => {
  /**
   * The answer of a job standing at a stage with these units.
   * @param stage - The stage.
   * @param units - The DO's units.
   * @param route - The route.
   * @returns It.
   */
  const at = (stage: string, units: Record<string, Unit> = {}, route: Route = 'encode'): Record<string, unknown> =>
    prepareAnswer({ route, units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage, failure: null } });

  it('DS01 from plan: advance to count, record Sub, then submit the count attempt 1 and wait', async () => {
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([expect.objectContaining({ storageKey: KEY, sourceFingerprint: H, jobId: JOB, deadlineAt: D, token: 'token-a', stage: 'count' })]);
    const job = submitted();
    const id = subJob('count', 1);
    expect(job).toEqual([expect.objectContaining({ jobId: id, containerClass: PRICING.standard4.containerClass, deadlineAt: D, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: KEY }] })]);
    // §7.17 grid_count: the count declares no output and names the plan's grid rule inputs.
    expect(job[0]!.outputs).toEqual([]);
    expect(job[0]!.count).toEqual({ kind: 'grid_count', inputId: SOURCE_INPUT_ID, gridStart: CONTENT.grid.gridStart, fps: CONTENT.grid.fps, gridEnd: CONTENT.grid.gridEnd });
    expect(actions('report_chunk')).toEqual([expect.objectContaining({ token: 'token-a', unit: { kind: 'presentation-count' }, report: { kind: 'Sub' } })]);
    expect(indexOf((call) => call.body?.action === 'report_chunk')).toBeLessThan(indexOf((call) => call.path === '/jobs' && call.method === 'POST'));
  });

  it('DS02 a reused edit file starts at encode: one chunk_encode attempt per window, each with its own key', async () => {
    answer = prepareAnswer({ route: 'reuse_edit' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['encode']);
    const jobs = submitted();
    expect(jobs.map((job) => job.jobId)).toEqual([subJob('chunk', 1, 0), subJob('chunk', 1, 1)]);
    expect(jobs.map((job) => (job.outputs as { recipe: { frames: unknown } }[])[0]!.recipe.frames)).toEqual([{ start: 0, end: 48 }, { start: 48, end: 96 }]);
    expect(new Set(jobs.map((job) => (job.outputs as { storageKey: string }[])[0]!.storageKey)).size).toBe(2);
    expect(actions('report_chunk').map((body) => body.unit)).toEqual([{ kind: 'presentation-chunk', chunk: 0 }, { kind: 'presentation-chunk', chunk: 1 }]);
  });

  it('DS03 a done count moves the encode route to encode and dispatches its chunks', async () => {
    answer = at('count', { [`video-presentation:${JOB}:count`]: unit(subJob('count', 1), 'done', 'done', 1, true) });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['encode']);
    expect(submitted().map((job) => job.jobId)).toEqual([subJob('chunk', 1, 0), subJob('chunk', 1, 1)]);
  });

  it('DS03b a done count moves the edit route to edit and dispatches one edit_encode per edit chunk', async () => {
    answer = at('count', { [`video-presentation:${JOB}:count`]: unit(subJob('count', 1), 'done', 'done', 1, true) }, 'edit');
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['edit']);
    expect(submitted().map((job) => job.jobId)).toEqual([0, 1, 2].map((chunk) => subJob('edit', 1, chunk)));
    expect(actions('report_chunk').map((body) => body.unit)).toEqual([0, 1, 2].map((chunk) => ({ kind: 'presentation-edit', chunk })));
  });

  it('DS04 stitch is dispatched only once every chunk is done, over the chunk outputs in order', async () => {
    answer = at('encode', {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 2, 1), 'done', 'done', 2, true),
    });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['stitch']);
    const jobs = submitted();
    expect(jobs.map((job) => job.jobId)).toEqual([subJob('stitch', 1)]);
    // Each chunk is a bound input under its chunk id, beside the source.
    expect(jobs[0]!.inputs).toEqual([{ inputId: SOURCE_INPUT_ID, storageKey: KEY }, { inputId: chunkInputId(0), storageKey: workKey(subJob('chunk', 1, 0)) },
      { inputId: chunkInputId(1), storageKey: workKey(subJob('chunk', 2, 1)) }]);
  });

  it('DS04b the edit stitch is dispatched once every edit chunk is done; once it is done the route moves to encode', async () => {
    const edits = Object.fromEntries([0, 1, 2].map((chunk) => [`video-presentation:${JOB}:edit:${chunk}`, unit(subJob('edit', 1, chunk), 'done', 'done', 1, true)]));
    answer = at('edit', edits, 'edit');
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['edit_stitch']);
    expect(submitted().map((job) => job.jobId)).toEqual([subJob('edit-stitch', 1)]);
    // The edit stitch reads its chunks alone.
    expect(submitted()[0]!.inputs).toEqual([0, 1, 2].map((chunk) => ({ inputId: chunkInputId(chunk), storageKey: workKey(subJob('edit', 1, chunk)) })));
    sent = [];
    // Once the edit file is measured the DO answers it, and the playback chunks read it (§5.1 2a row).
    answer = { ...at('edit_stitch', { ...edits, [`video-presentation:${JOB}:edit-stitch`]: unit(subJob('edit-stitch', 1), 'done', 'done', 1, true) }, 'edit'),
      plan: { ...plannedFacts('edit'), toolInputId: T, editStorageKey: EDIT_KEY } };
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['encode']);
    expect(submitted().map((job) => job.jobId)).toEqual([subJob('chunk', 1, 0), subJob('chunk', 1, 1)]);
    expect(submitted().map((job) => job.inputs)).toEqual([0, 1].map(() => [{ inputId: SOURCE_INPUT_ID, storageKey: EDIT_KEY }]));
  });

  it('DS06 every chunk dispatched, one finishing on this pickup and one still running: no advance to stitch and no stitch job', async () => {
    answer = prepareAnswer({ units: {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'open', 'pending'),
      [`video-presentation:${JOB}:chunk:2`]: unit(subJob('chunk', 1, 2), 'open', 'pending'),
    }, work: { kind: 'encode', chunks: [{ start: 0, end: 32 }, { start: 32, end: 64 }, { start: 64, end: 96 }] },
    preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    reports.set(subJob('chunk', 1, 1), finished(subJob('chunk', 1, 1), 'done', { wallMs: 1000, cpuUsec: 2000 }));
    reports.set(subJob('chunk', 1, 2), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([]);
    expect(submitted().some((job) => String(job.jobId).includes(':stitch:'))).toBe(false);
  });

  it('DS05 one chunk still open: no stitch yet', async () => {
    answer = at('encode', {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'open', 'pending'),
    });
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(actions('advance_stage')).toEqual([]);
    expect(submitted()).toEqual([]);
  });

  it('DS07 a reused version dispatches nothing: the DO publishes it', async () => {
    answer = prepareAnswer({ route: 'reuse' });
    await expect(advance()(data)).resolves.not.toThrow();
    expect(actions('advance_stage')).toEqual([]);
    expect(submitted()).toEqual([]);
  });
});

describe('what a done unit reports (§7.1.1 Done row; §91 D3-3; §4.1 frame count row)', () => {
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

  it('RD01 a done count is reported Done with the measured count and no receipt', async () => {
    const id = subJob('count', 1);
    answer = prepareAnswer({ units: { [`video-presentation:${JOB}:count`]: unit(id, 'open', 'pending') }, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'count', failure: null } });
    // The job report carries the count in place of an output.
    reports.set(id, finished(id, 'done', { wallMs: 1000, cpuUsec: 2000 }));
    await advance()(data).catch(() => undefined);
    const done = actions('report_chunk').find((body) => (body.report as { kind: string }).kind === 'Done');
    expect(done).toMatchObject({ unit: { kind: 'presentation-count' }, report: { kind: 'Done', attempt: 1, count: COUNT } });
    expect((done!.report as Record<string, unknown>).receipts).toBeUndefined();
  });

  it('RD02 a done edit stitch is reported Done with its edit file and the tier its recipe encoded', async () => {
    const id = subJob('edit-stitch', 1);
    const edits = Object.fromEntries([0, 1, 2].map((chunk) => [`video-presentation:${JOB}:edit:${chunk}`, unit(subJob('edit', 1, chunk), 'done', 'done', 1, true)]));
    answer = prepareAnswer({ route: 'edit', units: { ...edits, [`video-presentation:${JOB}:edit-stitch`]: unit(id, 'open', 'pending') },
      preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'edit_stitch', failure: null } });
    reports.set(id, finished(id, 'done', { wallMs: 5000, cpuUsec: 20_000_000 }));
    await advance()(data).catch(() => undefined);
    const done = actions('report_chunk').find((body) => (body.report as { kind: string }).kind === 'Done');
    expect(done).toMatchObject({ unit: { kind: 'presentation-edit-stitch' },
      report: { kind: 'Done', attempt: 1, receipts: [{ role: 'edit', storageKey: workKey(id), sha256: 'f'.repeat(64), sizeBytes: 100, contentType: 'video/mp4', tier: TIER }] } });
  });

  it('RD03 a done chunk is reported Done with no receipt', async () => {
    const id = subJob('chunk', 1, 0);
    answer = prepareAnswer({ units: { [`video-presentation:${JOB}:chunk:0`]: unit(id, 'open', 'pending'), [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'open', 'pending') },
      preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    reports.set(id, finished(id, 'done', { wallMs: 1000, cpuUsec: 2000 }));
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
    await advance()(data).catch(() => undefined);
    const done = actions('report_chunk').find((body) => (body.report as { kind: string }).kind === 'Done');
    expect(done).toEqual(expect.objectContaining({ unit: { kind: 'presentation-chunk', chunk: 0 }, report: { kind: 'Done', attempt: 1, usage: 1000 } }));
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
    ['stitch', 'encode', {
      [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'done', 'done', 1, true),
      [`video-presentation:${JOB}:stitch`]: unit(subJob('stitch', 1), 'done', 'done', 1, true),
    }],
  ] as const)('PU01 after a done %s the worker advances to publish and never sends a bundle', async (_name, route, units) => {
    answer = prepareAnswer({ route, units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'stitch', failure: null } });
    await advance()(data).catch(() => undefined);
    expect(actions('advance_stage').map((body) => body.stage)).toEqual(['publish']);
    expect(submitted()).toEqual([]);
    expect(sentBundle()).toBe(false);
  });

  it.each([
    ['stitch', 'encode', 'presentation-stitch'],
  ] as const)('PU02 a done %s attempt is reported Done with the job DO\'s measured receipts, its carrier tagged', async (kind, route, unitKind) => {
    const id = subJob(kind, 1);
    const units: Record<string, Unit> = { [`video-presentation:${JOB}:${kind}`]: unit(id, 'open', 'pending') };
    if (route === 'encode') {
      units[`video-presentation:${JOB}:chunk:0`] = unit(subJob('chunk', 1, 0), 'done', 'done', 1, true);
      units[`video-presentation:${JOB}:chunk:1`] = unit(subJob('chunk', 1, 1), 'done', 'done', 1, true);
    }
    answer = prepareAnswer({ route, units, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'stitch', failure: null } });
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
    expect(actions('record_chunk_usage')).toEqual([expect.objectContaining({ unit: { kind: 'presentation-chunk', chunk: 0 }, attempt: 1, usage: 1000 })]);
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
      expect(actions('record_chunk_usage')).toEqual([expect.objectContaining({ attempt: 1, usage: 1000 })]);
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
    answer = prepareAnswer({ route: 'reuse', usageFact, preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'plan', failure: null } });
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
});

// frames-split §7.1.1 (Exp row; invariant: recovery waits until every measured attempt is recorded) and §7.6: once the candidate
// failed, was archived or passed D, the job only reads its attempts' job reports, records each ended attempt's usage once and
// sends it with the job id alone; a missing job is nothing to record and nothing is ever submitted.
describe('an ended candidate settles its attempts read-only (inner#1306 §7.1.1 Exp, §7.6)', () => {
  const open = (state = 'open', attemptState = 'pending'): Record<string, Unit> => ({
    [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'done', 'done', 1, true),
    [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), state, attemptState),
  });
  const past = (): Record<string, unknown> => prepareAnswer({ capability: null, plan: null, work: { kind: 'none' }, units: open('failed', 'failed'),
    preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: 'expired' } });

  it.each([
    ['a failed candidate', { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: 'tool_failed' }],
    ['an archived candidate', { targetPolicyVersion: 1, jobId: 'video-presentation-b', stage: 'plan', failure: null }],
  ])('EN01 %s never submits a pending attempt: a job it cannot read is nothing to record', async (_name, preparation) => {
    answer = prepareAnswer({ units: open(), preparation });
    await expect(advance()(data)).resolves.not.toThrow();
    expect(submitted()).toEqual([]);
    expect(createUsageRecorder).not.toHaveBeenCalled();
  });

  it('EN02 past D an ended attempt\'s usage is recorded once at the frozen standard-4 price and sent with the job id alone', async () => {
    answer = past();
    const usage = { wallMs: 60_000, cpuUsec: 120_000_000 };
    reports.set(subJob('chunk', 1, 1), finished(subJob('chunk', 1, 1), 'done', usage));
    await expect(advance()(data)).resolves.not.toThrow();
    expect(createUsageRecorder).toHaveBeenCalledTimes(1);
    expect(createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ operationKey: subJob('chunk', 1, 1), multiplier: 0, actorUserId: ACTOR }));
    expect(recordServiceCall).toHaveBeenCalledWith(expect.objectContaining({ costUsd: containerCostUsd(usage, PRICING.standard4.size, PRICING.standard4.prices) }));
    expect(actions('record_chunk_usage')).toEqual([{ action: 'record_chunk_usage', storageKey: KEY, sourceFingerprint: H, jobId: JOB,
      unit: { kind: 'presentation-chunk', chunk: 1 }, attempt: 1, usage: usage.wallMs }]);
    const sentUsage = vi.mocked(fetch).mock.calls.findIndex(([, init]) => typeof init?.body === 'string' && init.body.includes('"record_chunk_usage"'));
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan((vi.mocked(fetch).mock.invocationCallOrder[sentUsage])!);
    expect(submitted()).toEqual([]);
  });

  it('EN03 past D an attempt whose container still runs keeps the job waiting', async () => {
    answer = past();
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
    await expect(advance()(data)).rejects.toBeInstanceOf(StillRunning);
    expect(createUsageRecorder).not.toHaveBeenCalled();
  });

  it('EN04 at D the job fails `expired`, then settles the attempt in flight read-only', async () => {
    D = Date.now() - 1;
    answer = prepareAnswer({ units: open(), preparation: { targetPolicyVersion: 1, jobId: JOB, stage: 'encode', failure: null } });
    reports.set(subJob('chunk', 1, 1), finished(subJob('chunk', 1, 1), 'failed', { wallMs: 2000, cpuUsec: null }));
    await expect(advance()(data)).resolves.not.toThrow();
    expect(indexOf((call) => call.body?.action === 'fail')).toBeLessThan(indexOf((call) => call.body?.action === 'record_chunk_usage'));
    expect(actions('record_chunk_usage')).toEqual([expect.objectContaining({ attempt: 1, usage: 2000 })]);
    expect(submitted()).toEqual([]);
  });
});

describe('a job BullMQ gave up on is settled from the queue failed event (frames-split design §7.1 failure sources)', () => {
  interface FakeJob { id: string; data: typeof data; finishedOn?: number }
  /**
   * A queue that answers one job and records what is added back.
   * @param job - The job `getJob` answers, or undefined.
   * @returns The fake queue and the jobs added to it.
   */
  function queueWith(job: FakeJob | undefined): { queue: { getJob: (id: string) => Promise<FakeJob | undefined>; add: ReturnType<typeof vi.fn> }; added: unknown[][] } {
    const added: unknown[][] = [];
    const add = vi.fn(async (...args: unknown[]) => { added.push(args); return {}; });
    return { queue: { getJob: async (id: string) => (job?.id === id ? job : undefined), add }, added };
  }
  /**
   * The handler under test.
   * @returns The exported settle function.
   */
  function settleExhausted(): (queue: unknown, jobId: string) => Promise<void> {
    const fn = (handler as Record<string, unknown>).settleExhaustedVideoPresentation as ((queue: unknown, jobId: string) => Promise<void>) | undefined;
    expect(fn, 'settleExhaustedVideoPresentation is exported from @worker/handlers/video-presentation.js').toBeTypeOf('function');
    return fn!;
  }

  it('AB01 a failure with a retry still to come asks ingest nothing and queues nothing', async () => {
    const { queue, added } = queueWith({ id: JOB, data });
    await settleExhausted()(queue, JOB);
    expect(sent).toEqual([]);
    expect(added).toEqual([]);
  });

  it('AB02 a job that used up its retries is abandoned by its job id alone and queued once more under its settle id', async () => {
    const { queue, added } = queueWith({ id: JOB, data, finishedOn: Date.now() });
    await settleExhausted()(queue, JOB);
    expect(actions('abandon')).toEqual([{ action: 'abandon', storageKey: KEY, sourceFingerprint: H, jobId: JOB }]);
    expect(actions('prepare')).toEqual([]);
    expect(added).toEqual([['prepare', data, expect.objectContaining({ jobId: `${JOB}-settle`, attempts: expect.any(Number) })]]);
  });

  it('AB03 the settle job giving up abandons again and queues the same settle id, never a new one', async () => {
    const { queue, added } = queueWith({ id: `${JOB}-settle`, data, finishedOn: Date.now() });
    await settleExhausted()(queue, `${JOB}-settle`);
    expect(actions('abandon')).toEqual([{ action: 'abandon', storageKey: KEY, sourceFingerprint: H, jobId: JOB }]);
    expect(added).toEqual([['prepare', data, expect.objectContaining({ jobId: `${JOB}-settle` })]]);
  });

  it.each([
    ['a job the queue no longer holds', null, undefined],
    ['a gone row', null, { id: JOB, data, finishedOn: 1 }],
    ['a deleted row', { ...asset, deletedAt: new Date() }, { id: JOB, data, finishedOn: 1 }],
    ['a row whose bytes changed', { ...asset, contentHash: 'b'.repeat(64) }, { id: JOB, data, finishedOn: 1 }],
  ])('AB04 settles nothing for %s', async (_name, row, job) => {
    if (job !== undefined) findById.mockResolvedValue(row);
    const { queue, added } = queueWith(job);
    await settleExhausted()(queue, JOB);
    expect(sent).toEqual([]);
    expect(added).toEqual([]);
  });
});

describe('a change readers see is told to the Projects showing the video (frames-split §7.20)', () => {
  const P1 = '7a1f2c0e-0000-4000-8000-000000000001';
  const P2 = '7a1f2c0e-0000-4000-8000-000000000002';
  const URL = `https://assets.example.test/${KEY}`;
  const BOTH = [[P1, asset.id, URL], [P2, asset.id, URL]];
  /**
   * Run one pickup the way the queue does.
   * @returns The rejection, if the pickup threw.
   */
  const pickup = async (): Promise<unknown> => {
    const job = { data, moveToDelayed: vi.fn(async () => undefined) };
    return handler.runVideoPresentation(job as never, 'lock').then(() => undefined, (error: unknown) => error);
  };
  /**
   * Two chunks at the encode stage.
   * @param failure - The preparation's failure code, if it failed.
   * @param jobId - The current job.
   * @returns The answer.
   */
  const encoding = (failure: string | null = null, jobId = JOB): Record<string, unknown> => prepareAnswer({
    units: { [`video-presentation:${JOB}:chunk:0`]: unit(subJob('chunk', 1, 0), 'open', 'pending'), [`video-presentation:${JOB}:chunk:1`]: unit(subJob('chunk', 1, 1), 'open', 'pending') },
    preparation: { targetPolicyVersion: 1, jobId, stage: 'encode', failure },
  });

  beforeEach(() => {
    listProjectsReferencingStorageKey.mockReset().mockResolvedValue([P1, P2]);
    publishVideoPresentationChanged.mockReset().mockResolvedValue(undefined);
    reports.set(subJob('chunk', 1, 0), { schemaVersion: 2, state: 'running' });
    reports.set(subJob('chunk', 1, 1), { schemaVersion: 2, state: 'running' });
  });

  it('VP01 a pickup that ends the job tells each Project referencing the video\'s storage key, with its registered address', async () => {
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' } });
    expect(await pickup()).toBeUndefined();
    expect(listProjectsReferencingStorageKey).toHaveBeenCalledWith(KEY);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it('VP02 a pickup that goes back to wait with what readers see unchanged since the last message tells nobody', async () => {
    answer = encoding();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    publishVideoPresentationChanged.mockClear();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged).not.toHaveBeenCalled();
  });

  it('VP03 a source row that is gone asks for no recipients and tells nobody', async () => {
    findById.mockResolvedValue(null);
    expect(await pickup()).toBeUndefined();
    expect(listProjectsReferencingStorageKey).not.toHaveBeenCalled();
    expect(publishVideoPresentationChanged).not.toHaveBeenCalled();
  });

  it('VP04 a message that cannot be sent is logged, the other Projects are still told and the next pickup sends again', async () => {
    answer = encoding();
    publishVideoPresentationChanged.mockRejectedValueOnce(new Error('redis down'));
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ projectId: P1 }) }), 'video_presentation_changed_publish_failed');
    publishVideoPresentationChanged.mockClear();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
  });

  it('VP05 recipients that cannot be read are logged under their own name and the job still ends', async () => {
    answer = prepareAnswer({ capability: null, plan: null, work: { kind: 'none' } });
    listProjectsReferencingStorageKey.mockRejectedValueOnce(new Error('db down'));
    expect(await pickup()).toBeUndefined();
    expect(publishVideoPresentationChanged).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'video_presentation_changed_recipients_failed');
  });

  it('VP06 a failure already written at ingest, by an earlier pickup or by ingest itself, is told by the next pickup while another chunk still runs', async () => {
    answer = encoding();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    publishVideoPresentationChanged.mockClear();
    answer = encoding('expired');
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
  });

  it('VP07 a new job admitted by a Retry is told by the next pickup even when only the current job changed', async () => {
    answer = encoding();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    publishVideoPresentationChanged.mockClear();
    answer = encoding(null, 'video-presentation-b');
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
  });

  it('VP11 a selected version that changed while the job waits is told even when nothing else changed', async () => {
    answer = encoding();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    publishVideoPresentationChanged.mockClear();
    answer = { ...encoding(), presentation: { ...frozenVersion(), sourceFingerprint: H } };
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
  });

  it('VP12 the announced view is kept under the deployment prefix for one task budget', async () => {
    answer = encoding();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(redisSet).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`:video-presentation:announced:${KEY}$`)), expect.any(String), 'PX', getNodeTaskConfig().default_budget_ms);
  });

  it('VP13 a view that cannot be read is announced anyway', async () => {
    answer = encoding();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    publishVideoPresentationChanged.mockClear();
    redisGet.mockRejectedValueOnce(new Error('redis down'));
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'video_presentation_changed_state_failed');
  });

  it('VP14 a view that cannot be recorded is announced again by the next pickup', async () => {
    answer = encoding();
    redisSet.mockRejectedValueOnce(new Error('redis down'));
    expect(await pickup()).toBeInstanceOf(DelayedError);
    publishVideoPresentationChanged.mockClear();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
  });

  it('VP08 a job the queue gave up on is told to the Projects once it is abandoned', async () => {
    const queue = { getJob: vi.fn(async () => ({ id: JOB, data, finishedOn: Date.now() })), add: vi.fn(async () => undefined) };
    await handler.settleExhaustedVideoPresentation(queue as never, JOB);
    expect(actions('abandon')).toHaveLength(1);
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
  });

  it('VP09 a pickup that ends the job tells each Project once, even when what readers see also changed', async () => {
    answer = encoding('expired');
    reports.clear();
    expect(await pickup()).toBeUndefined();
    expect(publishVideoPresentationChanged.mock.calls).toEqual(BOTH);
  });

  it('VP10 a pickup that reports a done chunk and goes back to wait for the other tells nobody', async () => {
    answer = encoding();
    expect(await pickup()).toBeInstanceOf(DelayedError);
    publishVideoPresentationChanged.mockClear();
    reports.set(subJob('chunk', 1, 0), finished(subJob('chunk', 1, 0), 'done', { wallMs: 1000, cpuUsec: 2000 }));
    expect(await pickup()).toBeInstanceOf(DelayedError);
    expect(actions('report_chunk').some((body) => (body.report as { kind: string }).kind === 'Done')).toBe(true);
    expect(publishVideoPresentationChanged).not.toHaveBeenCalled();
  });
});
