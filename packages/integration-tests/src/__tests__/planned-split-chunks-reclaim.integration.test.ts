// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A split segment encoded in chunks whose later chunk fails for good (frames-split design §5.4 用户运行的两层编码, §7.15
 * execution row, §7.19): each done chunk is pinned with the run when its result is recorded, so the run's done chunks are
 * registered for reclaim at the run's end, which a chunk failed for good brings at once.
 *
 * Real PostgreSQL admission, steps, pins and registration through the server app and the worker runner
 * `runMiniToolVideoTool`; the presentation snapshot, the stored ledger objects and the ingest `/jobs` boundary are faked.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import type * as sharedModule from "@breatic/shared";
import { videoPresentationWorkKeyFor } from "@breatic/shared";
import { planVideoSplit, videoContainerJobId } from "@breatic/shared/mini-tools";
import { miniToolExecutionService, runningSlotService, taskRepo } from "@breatic/domain";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { seedDesignatedLot, seedStudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { presentedSource } from "@server/__tests__/integration/presentation-fixtures.js";
import { INGEST_ENV } from "./ingest-jobs-fake.js";

const outside = vi.hoisted(() => ({ ingest: vi.fn(), snapshots: new Map<string, unknown>(), config: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof sharedModule>(), videoPresentationAtIngest: outside.ingest }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), getMiniToolsConfig: outside.config }));

interface Job { jobId: string; outputs: { outputIndex: number; storageKey: string; contentType: string }[] }
type Runner = (execution: unknown, userId: string, deadlineAt: number) => Promise<{ results: Map<number, Record<string, unknown>>; waiting: boolean }>;

const V = 5.055;
// A keyframe every 10 grid frames (0.05 s at 200 fps), so each chunk's decode pre-roll stays small beside its share.
const KEYFRAMES = { earliestKeyframeTime: 0, maxKeyframeInterval: 0.05, allKeyframes: false };
let pg: ReturnType<typeof core.createPgClient>;
let app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
let base: core.MiniToolsConfig;
let settings: core.MiniToolsConfig;
let publicUrl: (key: string) => string;
let submitted: Job[];
let failing: RegExp;
let running: RegExp;
const tokens: string[] = [];

/** Inject dummy external credentials only. @throws {Error} On invalid fixture configuration. */
function configure(): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
}

/**
 * The report for a job: still running when its id matches the running pattern, failed when it matches the failing
 * pattern, otherwise every declared output written.
 * @param request - The job.
 * @returns The report.
 */
function report(request: Job): Record<string, unknown> {
  const usage = { wallMs: 1000, cpuUsec: 2000000 };
  if (running.test(request.jobId)) return { schemaVersion: 2, state: "running" };
  if (failing.test(request.jobId)) return { schemaVersion: 2, state: "failed", reason: "tool_failed", outputs: [], usage };
  return { schemaVersion: 2, state: "done", usage, outputs: request.outputs.map((output) => ({ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64),
    sizeBytes: 2048, contentType: output.contentType, width: 960, height: 540, durationSeconds: 2, cover: null, upright: null })) };
}

beforeAll(async () => {
  configure(); core.loadLocales(); core.initLogger("split-chunks-reclaim-test");
  const actual = await vi.importActual<typeof core>("@breatic/core");
  base = structuredClone(actual.getMiniToolsConfig());
  pg = core.createPgClient(inject("DATABASE_URL"), { name: "split-chunks-reclaim", max: 6 });
  const storage = await core.getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
  app = (await import("@server/app.js")).createApp();
});
beforeEach(() => {
  vi.clearAllMocks(); configure();
  settings = structuredClone(base);
  // Every segment is encoded in keyframe chunks: a tenth of a second of encode work a frame against a 12 s share.
  const encoder = settings.encoding.encoder;
  encoder.start_seconds = 1;
  encoder.encode_pixels_per_second = 960 * 540 * 10;
  for (const key of Object.keys(encoder.decode_convert_pixels_per_second) as (keyof typeof encoder.decode_convert_pixels_per_second)[]) encoder.decode_convert_pixels_per_second[key] = 1e15;
  settings.encoding.chunk_share = 12 / (core.getNodeTaskConfig().default_budget_ms / 1000);
  settings.encoding.max_parallel_chunks = 64;
  outside.config.mockImplementation(() => settings);
  submitted = []; failing = /$^/; running = /$^/;
  outside.snapshots.clear();
  outside.ingest.mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    const snapshot = outside.snapshots.get(input.storageKey);
    if (input.action !== "read" || !snapshot) throw new Error(`Unexpected presentation admission ${input.action}`);
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Job; submitted.push(request);
      return Response.json(report(request));
    }
    if (url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const request = submitted.find((candidate) => candidate.jobId === id);
      return request === undefined ? new Response("missing", { status: 404 }) : Response.json(report(request));
    }
    return new Response("unexpected", { status: 500 });
  }));
});
afterAll(async () => {
  for (const token of tokens) await core.revokeSession(core.getRedis(), token);
  await pg.end(); core.initCore(process.env); vi.unstubAllGlobals();
});

/**
 * Post to the mini-tool route as the user.
 * @param userId - The user.
 * @param body - The request body.
 * @returns The response.
 * @throws {Error} On session storage failure.
 */
async function post(userId: string, body: unknown): Promise<Response> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, userId);
  return app.request("/api/v1/mini-tools", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID(), Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(body) });
}

/**
 * The work keys of every chunk of the run whose result was recorded done.
 * @param taskId - The run.
 * @param output - The segment.
 * @returns Their keys, sorted.
 * @throws {Error} On fixture SQL failure.
 */
async function doneChunkKeys(taskId: string, output: number): Promise<string[]> {
  return (await pg<{ key: string }[]>`SELECT output#>>'{miniToolPlanJob,outputs,0,storageKey}' AS key FROM task_upstream_steps
    WHERE task_id=${taskId} AND output#>>'{miniToolStep,result,outcome}'='done' AND output#>>'{miniToolPlanJob,jobId}' LIKE ${`%:out:${output}:enc:%`}`)
    .map((row) => row.key).sort();
}

/**
 * Pickups until an output fails for good, as a run fails whole (frames-split §7.19).
 * @param run - The runner.
 * @param args - Its arguments.
 * @returns The last pickup's results.
 * @throws {Error} When a pickup throws anything but StillRunning.
 */
async function untilFailure(run: Runner, ...args: Parameters<Runner>): Promise<Map<number, Record<string, unknown>>> {
  let results = new Map<number, Record<string, unknown>>();
  for (let pickup = 0; pickup < 60 && ![...results.values()].some((result) => result.status === "failed"); pickup += 1) {
    try { results = (await run(...args)).results; } catch (error) { if (!(error instanceof StillRunning)) throw error; }
  }
  return results;
}

describe("a failed run's done chunks (frames-split §5.4, §7.15, §7.19)", () => {
  it("SR01 are registered for reclaim at the failed end of the run", async () => {
    const target = await seedStudioFixture(pg, "split-reclaim");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
    await seedDesignatedLot(pg, target, 1000);
    const sourceId = randomUUID(); const sourceKey = `video/split-reclaim/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
    const presented = await presentedSource(hash, sourceKey, publicUrl, { keyframes: KEYFRAMES });
    outside.snapshots.set(sourceKey, presented.snapshot);
    // The cut 2.5 s in, as a frame of the selected grid (frames-split §10.7).
    const grid = { fps: presented.bundle.display.fps, frameCount: presented.bundle.display.frameCount };
    const cuts = [Math.round((2.5 * grid.fps.numerator) / grid.fps.denominator)];
    const body = { tool: "video.split", project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
      draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: randomUUID(), canonicalURL: publicUrl(sourceKey),
        mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } }, inputs: [], params: { cuts } },
      analysis_refs: [], presentation_ref: presented.presentationRef,
      outputs: planVideoSplit(grid, cuts).map((output) => ({ outputIndex: output.outputIndex, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: output.start, end: output.end } } })) };
    const admitted = await post(target.userId, body);
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    // The running-task gate starts a pending task before its pickup does (inner#1968).
    await runningSlotService.startWithinLimit({ id: body.run_id, jobId: body.run_id });
    const { task, execution } = await miniToolExecutionService.startMiniToolExecution(body.run_id, body.run_id);
    const plan = execution as unknown as { layout: { encodes: { outputIndex: number; chunks: unknown[] }[] }; outputs: { outputIndex: number; nodeId: string; recipe: unknown }[]; planFingerprint: string };
    const encode = plan.layout.encodes.find((entry) => entry.outputIndex === 0);
    expect(encode?.chunks.length).toBeGreaterThan(1);
    // The last chunk of segment 0 fails on every attempt; its earlier chunks are done.
    const last = encode!.chunks.length - 1;
    failing = new RegExp(`:out:0:enc:${last}:`);
    const stored = await taskRepo.getMiniToolExecutionTask(task.id);
    const deadlineAt = await taskDeadline(task.id, stored!.createdAt);
    const run = ((await import("@worker/handlers/mini-tool/run-video-tool.js")) as unknown as Record<string, Runner>).runMiniToolVideoTool!;
    const results = await untilFailure(run, execution, task.userId, deadlineAt);
    expect(results.get(0)).toMatchObject({ status: "failed" });
    const done = await doneChunkKeys(task.id, 0);
    expect(done.length).toBeGreaterThan(0);
    const queued = async (): Promise<string[]> => (await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE storage_key=ANY(${done}) AND kind='derived'`).map((row) => row.storage_key).sort();
    expect(await queued()).toEqual([]);
    const error = { code: "mini_tool_failed" };
    await miniToolExecutionService.finishMiniToolExecution(task.id, { planFingerprint: plan.planFingerprint, expectedVersion: 0, error,
      outputs: plan.outputs.map((output) => ({ ...output, result: { status: "failed", error } })) } as never);
    expect(await queued()).toEqual(done);
  });

  it("SR03 a chunk still running when the run fails has its work key registered for reclaim at the run's end", async () => {
    const target = await seedStudioFixture(pg, "split-reclaim");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
    await seedDesignatedLot(pg, target, 1000);
    const sourceId = randomUUID(); const sourceKey = `video/split-reclaim/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
    const presented = await presentedSource(hash, sourceKey, publicUrl, { keyframes: KEYFRAMES });
    outside.snapshots.set(sourceKey, presented.snapshot);
    // The cut 2.5 s in, as a frame of the selected grid (frames-split §10.7).
    const grid = { fps: presented.bundle.display.fps, frameCount: presented.bundle.display.frameCount };
    const cuts = [Math.round((2.5 * grid.fps.numerator) / grid.fps.denominator)];
    const body = { tool: "video.split", project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
      draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: randomUUID(), canonicalURL: publicUrl(sourceKey),
        mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } }, inputs: [], params: { cuts } },
      analysis_refs: [], presentation_ref: presented.presentationRef,
      outputs: planVideoSplit(grid, cuts).map((output) => ({ outputIndex: output.outputIndex, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: output.start, end: output.end } } })) };
    const admitted = await post(target.userId, body);
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    // The running-task gate starts a pending task before its pickup does (inner#1968).
    await runningSlotService.startWithinLimit({ id: body.run_id, jobId: body.run_id });
    const { task, execution } = await miniToolExecutionService.startMiniToolExecution(body.run_id, body.run_id);
    const plan = execution as unknown as { layout: { encodes: { outputIndex: number; chunks: unknown[] }[] }; outputs: { outputIndex: number; nodeId: string; recipe: unknown }[]; planFingerprint: string };
    const encode = plan.layout.encodes.find((entry) => entry.outputIndex === 0);
    expect(encode?.chunks.length).toBeGreaterThan(1);
    // The first chunk of segment 0 never ends; its last chunk fails on every attempt.
    const last = encode!.chunks.length - 1;
    running = new RegExp(`:out:0:enc:0:`);
    failing = new RegExp(`:out:0:enc:${last}:`);
    const stored = await taskRepo.getMiniToolExecutionTask(task.id);
    const deadlineAt = await taskDeadline(task.id, stored!.createdAt);
    const run = ((await import("@worker/handlers/mini-tool/run-video-tool.js")) as unknown as Record<string, Runner>).runMiniToolVideoTool!;
    const results = await untilFailure(run, execution, task.userId, deadlineAt);
    expect(results.get(0)).toMatchObject({ status: "failed" });
    const open = (await pg<{ key: string }[]>`SELECT output#>>'{miniToolPlanJob,outputs,0,storageKey}' AS key FROM task_upstream_steps
      WHERE task_id=${task.id} AND output->'miniToolStep'->'result' IS NULL AND output#>>'{miniToolPlanJob,jobId}' LIKE '%:out:0:enc:0:%'`).map((row) => row.key);
    expect(open).toHaveLength(1);
    const queued = async (): Promise<string[]> => (await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE storage_key=ANY(${open}) AND kind='derived'`).map((row) => row.storage_key);
    expect(await queued()).toEqual([]);
    const error = { code: "mini_tool_failed" };
    await miniToolExecutionService.finishMiniToolExecution(task.id, { planFingerprint: plan.planFingerprint, expectedVersion: 0, error,
      outputs: plan.outputs.map((output) => ({ ...output, result: { status: "failed", error } })) } as never);
    expect(await queued()).toEqual(open);
  });

  it("SR02 a stitched segment's chunks are registered at its stitch, the failed segment's done chunks at the run's end", async () => {
    const target = await seedStudioFixture(pg, "split-reclaim");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
    await seedDesignatedLot(pg, target, 1000);
    const sourceId = randomUUID(); const sourceKey = `video/split-reclaim/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
    const presented = await presentedSource(hash, sourceKey, publicUrl, { keyframes: KEYFRAMES });
    outside.snapshots.set(sourceKey, presented.snapshot);
    // The cut 2.5 s in, as a frame of the selected grid (frames-split §10.7).
    const grid = { fps: presented.bundle.display.fps, frameCount: presented.bundle.display.frameCount };
    const cuts = [Math.round((2.5 * grid.fps.numerator) / grid.fps.denominator)];
    const body = { tool: "video.split", project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
      draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: randomUUID(), canonicalURL: publicUrl(sourceKey),
        mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } }, inputs: [], params: { cuts } },
      analysis_refs: [], presentation_ref: presented.presentationRef,
      outputs: planVideoSplit(grid, cuts).map((output) => ({ outputIndex: output.outputIndex, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: output.start, end: output.end } } })) };
    const admitted = await post(target.userId, body);
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    // The running-task gate starts a pending task before its pickup does (inner#1968).
    await runningSlotService.startWithinLimit({ id: body.run_id, jobId: body.run_id });
    const { task, execution } = await miniToolExecutionService.startMiniToolExecution(body.run_id, body.run_id);
    const plan = execution as unknown as { layout: { encodes: { outputIndex: number; chunks: unknown[] }[] }; outputs: { outputIndex: number; nodeId: string; recipe: unknown }[]; planFingerprint: string };
    const chunksOf = (output: number): number => plan.layout.encodes.find((entry) => entry.outputIndex === output)!.chunks.length;
    expect(chunksOf(0)).toBeGreaterThan(1);
    expect(chunksOf(1)).toBeGreaterThan(1);
    // Segment 0 is encoded and stitched; the last chunk of segment 1 fails on every attempt, its earlier chunks are done.
    const last = chunksOf(1) - 1;
    failing = new RegExp(`:out:1:enc:${last}:`);
    const stored = await taskRepo.getMiniToolExecutionTask(task.id);
    const deadlineAt = await taskDeadline(task.id, stored!.createdAt);
    const run = ((await import("@worker/handlers/mini-tool/run-video-tool.js")) as unknown as Record<string, Runner>).runMiniToolVideoTool!;
    const results = await untilFailure(run, execution, task.userId, deadlineAt);
    expect(results.get(0)).toMatchObject({ status: "reported" });
    expect(results.get(1)).toMatchObject({ status: "failed" });
    const chunkKeys = (output: number, count: number): string[] => Array.from({ length: count }, (_unused, chunk) =>
      videoPresentationWorkKeyFor(sourceKey, videoContainerJobId({ kind: "run-chunk", taskId: task.id, output, chunk, attempt: 1 }))).sort();
    const stitched = chunkKeys(0, chunksOf(0)); const done = await doneChunkKeys(task.id, 1);
    const queued = async (): Promise<string[]> => (await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE storage_key=ANY(${[...stitched, ...done]}) AND kind='derived'`).map((row) => row.storage_key).sort();
    expect(await queued()).toEqual(stitched);
    const error = { code: "mini_tool_failed" };
    await miniToolExecutionService.finishMiniToolExecution(task.id, { planFingerprint: plan.planFingerprint, expectedVersion: 0, error,
      outputs: plan.outputs.map((output) => ({ ...output, result: { status: "failed", error } })) } as never);
    expect(await queued()).toEqual([...stitched, ...done].sort());
    const pinned = (await pg<{ storage_key: string }[]>`SELECT o.storage_key FROM presentation_pin_objects o JOIN presentation_pins p ON p.id=o.pin_id
      WHERE p.holder_kind='execution' AND p.holder_id=${task.id} AND p.deleted_at IS NULL`).map((row) => row.storage_key);
    expect(pinned).toEqual([]);
  });
});

// C15 for split: a container-only run the queue cleanup ends has no submit
// attempt to wait for, so its consumption set closes and its measured usage settles; every output fails (frames-split §7.19).
describe("a split the queue cleanup ends closes its consumption set (execution design §6.12)", () => {
  it("C15s a split whose jobs all ended closes at cleanup, fails every output, releases its hold and charges its container usage", async () => {
    core.initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", STRIPE_SECRET_KEY: "sk_test_unused", STRIPE_WEBHOOK_SECRET: "whsec_unused",
      UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
    const target = await seedStudioFixture(pg, "split-cleanup");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
    await seedDesignatedLot(pg, target, 1000);
    const sourceId = randomUUID(); const sourceKey = `video/split-cleanup/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
    const presented = await presentedSource(hash, sourceKey, publicUrl, { keyframes: KEYFRAMES });
    outside.snapshots.set(sourceKey, presented.snapshot);
    // The cut 2.5 s in, as a frame of the selected grid (frames-split §10.7).
    const grid = { fps: presented.bundle.display.fps, frameCount: presented.bundle.display.frameCount };
    const cuts = [Math.round((2.5 * grid.fps.numerator) / grid.fps.denominator)];
    const body = { tool: "video.split", project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
      draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: randomUUID(), canonicalURL: publicUrl(sourceKey),
        mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } }, inputs: [], params: { cuts } },
      analysis_refs: [], presentation_ref: presented.presentationRef,
      outputs: planVideoSplit(grid, cuts).map((output) => ({ outputIndex: output.outputIndex, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: output.start, end: output.end } } })) };
    const admitted = await post(target.userId, body);
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    // The running-task gate starts a pending task before its pickup does (inner#1968).
    await runningSlotService.startWithinLimit({ id: body.run_id, jobId: body.run_id });
    const { task, execution } = await miniToolExecutionService.startMiniToolExecution(body.run_id, body.run_id);
    const stored = await taskRepo.getMiniToolExecutionTask(task.id);
    const deadlineAt = await taskDeadline(task.id, stored!.createdAt);
    const run = ((await import("@worker/handlers/mini-tool/run-video-tool.js")) as unknown as Record<string, Runner>).runMiniToolVideoTool!;
    let results = new Map<number, Record<string, unknown>>();
    for (let pickup = 0; pickup < 60 && results.size < body.outputs.length; pickup += 1) {
      try { results = (await run(execution, task.userId, deadlineAt)).results; } catch (error) { if (!(error instanceof StillRunning)) throw error; }
    }
    expect([...results.values()].map((result) => result.status)).toEqual(body.outputs.map(() => "reported"));
    // The worker died at its terminal commit, so only the queue cleanup ends the run.
    const { cleanupFailedJobNodes } = await import("@worker/handlers/failed-job-cleanup.js");
    await cleanupFailedJobNodes(core.getStreamRedis(), { name: "execute-mini-tool", data: { taskId: task.id, source: "mini_tool", executionKind: "planned" }, finishedOn: Date.now() }, "worker died");
    const [ended] = await pg<{ status: string; complete: unknown }[]>`SELECT status,result#>'{settlement,consumptionSetComplete}' AS complete FROM tasks WHERE id=${task.id}`;
    expect(ended).toEqual({ status: "failed", complete: true });
    const { record } = await miniToolExecutionService.startMiniToolExecution(task.id, task.id);
    expect(record.outputs.map((output) => output.result?.status)).toEqual(body.outputs.map(() => "failed"));
    const { runMiniToolSettlement } = await import("@breatic/domain");
    for (let round = 0; round < 60; round += 1) {
      const wake = await taskRepo.waitingMiniToolSettlement(task.id);
      if (wake === null) break;
      const result = await runMiniToolSettlement({ taskId: task.id, settlementVersion: wake.settlementVersion }, async () => ({ state: "known", costUsd: 0.01, costSource: "computed", raw: { fixtureCost: 0.01 } }));
      if (result.failure !== undefined) throw result.failure;
    }
    const [billed] = await pg<{ billed: number | null }[]>`SELECT billed_credits::float8 AS billed FROM tasks WHERE id=${task.id}`;
    expect(billed!.billed).toBeGreaterThan(0);
    expect((await pg<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${task.id}`).map((row) => row.status)).toEqual(["released"]);
    expect((await pg<{ amount: number }[]>`SELECT amount::float8 AS amount FROM credit_ledger WHERE reference_id=${task.id} AND entry_type='spend'`).map((row) => row.amount)).toEqual([-billed!.billed!]);
  });
});
