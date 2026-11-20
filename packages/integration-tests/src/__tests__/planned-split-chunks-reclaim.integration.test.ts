// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A split segment encoded in chunks whose later chunk fails for good (frames-split design §5.4 用户运行的两层编码, §7.15
 * execution row and 可重试结束): each done chunk is pinned with the run when its result is recorded, so the failed segment's
 * done chunks are registered for reclaim once nothing can retry the run any more, here when a retry takes the failed
 * output over.
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
import { creditHoldService, miniToolExecutionService, taskRepo } from "@breatic/domain";
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
let pg: ReturnType<typeof core.createPgClient>;
let app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
let base: core.MiniToolsConfig;
let settings: core.MiniToolsConfig;
let publicUrl: (key: string) => string;
let submitted: Job[];
let failing: RegExp;
const tokens: string[] = [];

/** Inject dummy external credentials only. @throws {Error} On invalid fixture configuration. */
function configure(): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
}

/**
 * The report for a job: failed when its id matches the failing pattern, otherwise every declared output written.
 * @param request - The job.
 * @returns The report.
 */
function report(request: Job): Record<string, unknown> {
  const usage = { wallMs: 1000, cpuUsec: 2000000 };
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
  // Every segment is encoded in keyframe chunks: one frame a second of encode work against a 12 s share.
  const encoder = settings.encoding.encoder;
  encoder.start_seconds = 1;
  encoder.encode_pixels_per_second = 960 * 540;
  for (const key of Object.keys(encoder.decode_convert_pixels_per_second) as (keyof typeof encoder.decode_convert_pixels_per_second)[]) encoder.decode_convert_pixels_per_second[key] = 1e15;
  settings.encoding.chunk_share = 12 / (core.getNodeTaskConfig().default_budget_ms / 1000);
  settings.encoding.max_parallel_chunks = 64;
  outside.config.mockImplementation(() => settings);
  submitted = []; failing = /$^/;
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

describe("a failed segment's done chunks (frames-split §5.4, §7.15)", () => {
  it("SR01 are registered for reclaim once a retry takes the failed segment over", async () => {
    const target = await seedStudioFixture(pg, "split-reclaim");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
    await seedDesignatedLot(pg, target, 1000);
    const sourceId = randomUUID(); const sourceKey = `video/split-reclaim/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
    const presented = await presentedSource(hash, sourceKey, publicUrl);
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
    let results = new Map<number, Record<string, unknown>>();
    for (let pickup = 0; pickup < 60 && results.size < plan.outputs.length; pickup += 1) {
      try { results = (await run(execution, task.userId, deadlineAt)).results; } catch (error) { if (!(error instanceof StillRunning)) throw error; }
    }
    expect(results.get(0)).toMatchObject({ status: "failed" });
    const doneChunks = Array.from({ length: last }, (_unused, chunk) => videoPresentationWorkKeyFor(sourceKey, videoContainerJobId({ kind: "run-chunk", taskId: task.id, output: 0, chunk, attempt: 1 })));
    const queued = async (): Promise<string[]> => (await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE storage_key=ANY(${doneChunks}) AND kind='derived'`).map((row) => row.storage_key).sort();
    const error = { code: "mini_tool_failed" };
    await miniToolExecutionService.finishMiniToolExecution(task.id, { planFingerprint: plan.planFingerprint, expectedVersion: 0, error,
      outputs: plan.outputs.map((output) => ({ ...output, late: false, result: results.get(output.outputIndex)! })) } as never);
    // A retryable failure keeps the run's pins, so its done chunks wait with them.
    expect(await queued()).toEqual([]);
    await pg`UPDATE node_tasks SET status='failed',settled_at=clock_timestamp() WHERE task_id=${task.id}`;
    await creditHoldService.releaseHold(task.id);
    const retried = await post(target.userId, { tool: "video.split", project_id: target.projectId, space_id: body.space_id, run_id: randomUUID(), retry: { runId: task.id, outputIndexes: [0] } });
    expect(retried.status, await retried.clone().text()).toBe(201);
    expect(await queued()).toEqual([...doneChunks].sort());
  });

  it("SR02 a stitched segment's chunks are registered at its stitch while a retryable failed segment's done chunks stay pinned", async () => {
    const target = await seedStudioFixture(pg, "split-reclaim");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
    await seedDesignatedLot(pg, target, 1000);
    const sourceId = randomUUID(); const sourceKey = `video/split-reclaim/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
    const presented = await presentedSource(hash, sourceKey, publicUrl);
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
    let results = new Map<number, Record<string, unknown>>();
    for (let pickup = 0; pickup < 60 && results.size < plan.outputs.length; pickup += 1) {
      try { results = (await run(execution, task.userId, deadlineAt)).results; } catch (error) { if (!(error instanceof StillRunning)) throw error; }
    }
    expect(results.get(0)).toMatchObject({ status: "registered" });
    expect(results.get(1)).toMatchObject({ status: "failed" });
    const chunkKeys = (output: number, count: number): string[] => Array.from({ length: count }, (_unused, chunk) =>
      videoPresentationWorkKeyFor(sourceKey, videoContainerJobId({ kind: "run-chunk", taskId: task.id, output, chunk, attempt: 1 }))).sort();
    const stitched = chunkKeys(0, chunksOf(0)); const waiting = chunkKeys(1, last);
    const error = { code: "mini_tool_failed" };
    await miniToolExecutionService.finishMiniToolExecution(task.id, { planFingerprint: plan.planFingerprint, expectedVersion: 0, error,
      outputs: plan.outputs.map((output) => ({ ...output, late: false, result: results.get(output.outputIndex)! })) } as never);
    const queued = (await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE storage_key=ANY(${[...stitched, ...waiting]}) AND kind='derived'`).map((row) => row.storage_key).sort();
    expect(queued).toEqual(stitched);
    const pinned = (await pg<{ storage_key: string }[]>`SELECT o.storage_key FROM presentation_pin_objects o JOIN presentation_pins p ON p.id=o.pin_id
      WHERE p.holder_kind='execution' AND p.holder_id=${task.id} AND p.deleted_at IS NULL AND o.storage_key=ANY(${[...stitched, ...waiting]})`).map((row) => row.storage_key).sort();
    expect(pinned).toEqual(waiting);
  });
});

// C15 for split (planned-terminal-closure.integration.test.ts): a container-only run the queue cleanup ends has no submit
// attempt to wait for, so its consumption set closes and its measured usage settles. C15p: a segment a progress commit
// already registered stays registered at cleanup (design line 622), so the cleanup's terminal commit is not refused.
describe("a split the queue cleanup ends closes its consumption set (execution design §6.12)", () => {
  it.each([
    { name: "C15s a split whose jobs all ended", progress: false },
    { name: "C15p a split whose first segment a progress commit registered", progress: true },
  ])("$name closes at cleanup, releases its hold and charges its container usage", async ({ progress }) => {
    core.initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", STRIPE_SECRET_KEY: "sk_test_unused", STRIPE_WEBHOOK_SECRET: "whsec_unused",
      UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
    const target = await seedStudioFixture(pg, "split-cleanup");
    await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
    await seedDesignatedLot(pg, target, 1000);
    const sourceId = randomUUID(); const sourceKey = `video/split-cleanup/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
    await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
      VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
    const presented = await presentedSource(hash, sourceKey, publicUrl);
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
    const { task, execution } = await miniToolExecutionService.startMiniToolExecution(body.run_id, body.run_id);
    const stored = await taskRepo.getMiniToolExecutionTask(task.id);
    const deadlineAt = await taskDeadline(task.id, stored!.createdAt);
    const run = ((await import("@worker/handlers/mini-tool/run-video-tool.js")) as unknown as Record<string, Runner>).runMiniToolVideoTool!;
    let results = new Map<number, Record<string, unknown>>();
    for (let pickup = 0; pickup < 60 && results.size < body.outputs.length; pickup += 1) {
      try { results = (await run(execution, task.userId, deadlineAt)).results; } catch (error) { if (!(error instanceof StillRunning)) throw error; }
    }
    expect([...results.values()].map((result) => result.status)).toEqual(body.outputs.map(() => "registered"));
    if (progress) {
      // An earlier pickup committed segment 0 non-terminally while segment 1 was still encoding.
      const plan = execution as unknown as { outputs: { outputIndex: number; nodeId: string; recipe: unknown }[]; planFingerprint: string };
      await miniToolExecutionService.commitMiniToolExecutionProgress(task.id, { planFingerprint: plan.planFingerprint, expectedVersion: 0,
        outputs: plan.outputs.map((output) => ({ ...output, late: false, result: output.outputIndex === 0 ? results.get(0)! : null })) } as never);
    }
    // The worker died at its terminal commit, so only the queue cleanup ends the run.
    const { cleanupFailedJobNodes } = await import("@worker/handlers/failed-job-cleanup.js");
    await cleanupFailedJobNodes(core.getStreamRedis(), { name: "execute-mini-tool", data: { taskId: task.id, source: "mini_tool", executionKind: "planned" }, finishedOn: Date.now() }, "worker died");
    const [ended] = await pg<{ status: string; complete: unknown }[]>`SELECT status,result#>'{settlement,consumptionSetComplete}' AS complete FROM tasks WHERE id=${task.id}`;
    expect(ended).toEqual({ status: "failed", complete: true });
    const { record } = await miniToolExecutionService.startMiniToolExecution(task.id, task.id);
    expect(record.outputs.map((output) => output.result?.status)).toEqual(body.outputs.map((output) => progress && output.outputIndex === 0 ? "registered" : "failed"));
    if (progress) expect(record.outputs[0]!.result).toEqual(results.get(0));
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
