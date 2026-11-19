// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Erase and expand execution admission (inner#1306 execution design §10.4, §10.5, §10.6 and §10.8 server keys).
 *
 * Real admission, authorization, PG, Redis, holds and queue; only the external presentation snapshot (ingest) and the
 * stored ledger objects (fetch) are controlled, as in planned-lipsync-admission. The presented source has 1011 frames of
 * 1/200 s (5.055 s, 960x540), so an erase range is resampled on the 30 fps grid.
 *
 * Readings this file makes of the plan (recorded for review): an erase plan freezes `model`, `grid` (shared `modelGrid` over
 * the range's frames) and `modelCredits`; an expand plan freezes `layout` (shared `videoExpandLayout`), `prompt` (the
 * default text when the draft's is empty), `seed`, `windows` (shared `planModelWindows`) and `modelCredits`. Each refusal
 * is a 400 whose message is its `server.mini_tool.*` key, with no durable effect.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Queue } from "bullmq";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import * as shared from "@breatic/shared";
import * as miniTools from "@breatic/shared/mini-tools";
import { fingerprintMiniToolAnalysisInput, miniToolAnalysisRecordSchema, presentationFrameAt, projectMiniToolAnalysisInput, type VideoPresentationTable } from "@breatic/shared/mini-tools";
import { creditHoldService, estimateTaskCredits, miniToolExecutionService, miniToolFrozenAnalysisSchema } from "@breatic/domain";
import { appendExecutionPinObjects } from "@domain/presentation/presentation-pin.repo.js";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { presentedSource, REMOVAL_ENCODING, REMOVAL_PLAN, REMOVAL_TABLE, type PresentedSource } from "./presentation-fixtures.js";

type Range = { start: number; end: number };
type Frame = { x: number; y: number; width: number; height: number };
interface Fixture extends StudioFixture { body: Record<string, unknown> & { run_id: string; draft: { draftId: string; source: { nodeId: string; canonicalURL: string }; params: Record<string, unknown> }; analysis_refs: unknown[]; outputs: { nodeId: string }[] }; analysisRunId?: string }
interface Plan extends Record<string, unknown> { tool: string; credits: number; modelCredits?: number; stepKeys?: Record<string, string>; stepCredits?: Record<string, number> }

const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn(), config: vi.fn() }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), getMiniToolsConfig: outside.config }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));

// The shared planners admission must use (§10.4, §10.5); read by name so this file compiles before they exist.
const planners = miniTools as unknown as {
  modelGrid: (frames: Range[], maxFps: number) => { mode: string; rate: number; frameCount: number };
  videoExpandLayout: (frame: Frame, source: { width: number; height: number }, maxSide: number) => Record<string, unknown>;
  planModelWindows: (frames: Range[]) => { span: Range; duration: 5 | 10 }[];
};
const BRIA = "bria-video-eraser-mask";
const VACE = "wan-2.1-14b-vace";
const TRACKED_PROFILE = { id: "sam3-video-rle", version: "wavespeed-ai/sam3-video-rle", weightsHash: null, params: { apply_mask: false, default_prompt: "object" } };
const V = 5.055;
const ACCEPTED_AT = "2026-11-07T08:00:00.123456Z";

let pg: ReturnType<typeof core.createPgClient>;
let queue: Queue;
let app: Hono;
let base: core.MiniToolsConfig;
let settings: core.MiniToolsConfig;
let publicUrl: (key: string) => string;
const tokens: string[] = [];

/** Configure a real paid admission with a served (never called) WaveSpeed catalog. @throws {Error} On invalid deployment configuration. */
function configure(): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", STRIPE_SECRET_KEY: "sk_test_unused_erase",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_erase", WAVESPEED_API_KEY: "unused-by-erase-admission-tests", UPLOAD_BASE_URL: "https://assets.example.test" });
}

/** The §10.6 execution blocks; matte values are the composite tests'. @throws {never} Never. */
function executions(): Record<string, unknown> {
  return {
    "video.erase": { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1,
      model: { name: BRIA, min_seconds: 1, max_seconds: 5, max_grid_fps: 30, async_rejection: { path: "code", equals: 1401 } }, matte: { dilate: 4, feather: 4 } },
    "video.expand": { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1,
      model: { name: VACE, max_window_seconds: 10, overlap_seconds: 0.625, model_fps: 16 }, max_duration_seconds: 180, max_target_side: 4096 },
  };
}

beforeAll(async () => {
  configure(); core.loadLocales(); core.initLogger("erase-expand-admission-test");
  const actual = await vi.importActual<typeof core>("@breatic/core");
  base = structuredClone(actual.getMiniToolsConfig());
  pg = core.createPgClient(inject("DATABASE_URL"), { name: "erase-expand-admission-fixtures", max: 8 });
  const storage = await core.getStorageAdapter();
  publicUrl = storage.publicUrl.bind(storage);
  queue = core.createQueue("tasks");
  app = (await import("@server/app.js")).createApp();
});
beforeEach(() => {
  configure();
  settings = structuredClone(base);
  for (const [tool, block] of Object.entries(executions())) Reflect.set(settings.executions, tool, block);
  outside.config.mockImplementation(() => settings);
  outside.snapshots.clear(); outside.bodies.clear();
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = outside.bodies.get(url);
    if (body === undefined) throw new Error(`Admission must not fetch an unregistered URL: ${url}`);
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => {
  for (const token of tokens) await core.revokeSession(core.getRedis(), token);
  await pg.end(); core.initCore(process.env); vi.unstubAllGlobals();
});

/**
 * Register the source and its selected tool input and fund the Studio.
 * @param options - Whether the source is transparent.
 * @param options.transparent - A source whose presentation fills with transparency.
 * @returns The fixture parts every request needs.
 * @throws {Error} On fixture SQL failure.
 */
async function seedSource(options: { transparent?: boolean } = {}): Promise<StudioFixture & { sourceKey: string; presented: PresentedSource; binding: z.infer<typeof miniToolAnalysisRecordSchema>["binding"] }> {
  const target = await seedStudioFixture(pg, "erase");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
  await seedDesignatedLot(pg, target, 1000);
  const sourceId = randomUUID(); const sourceKey = `video/erase/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
  const plan = options.transparent ? { ...REMOVAL_PLAN, policy: { ...REMOVAL_PLAN.policy, emptyFill: "transparent" } } : REMOVAL_PLAN;
  const presented = await presentedSource(hash, sourceKey, publicUrl, { plan, encoding: REMOVAL_ENCODING });
  outside.snapshots.set(sourceKey, presented.snapshot);
  for (const [url, body] of presented.bodies) outside.bodies.set(url, body);
  const binding = { assetId: sourceId, contentHash: hash, canonicalURL: publicUrl(sourceKey), kind: "video" as const, mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } };
  return { ...target, sourceKey, presented, binding };
}

/**
 * The common request around a draft.
 * @param target - The seeded source.
 * @param tool - The tool.
 * @param params - The draft parameters.
 * @param recipe - The output recipe.
 * @returns The body.
 * @throws {never} Never.
 */
function request(target: Awaited<ReturnType<typeof seedSource>>, tool: string, params: Record<string, unknown>, recipe: string): Fixture["body"] {
  return { tool, project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
    draft: { version: 1, draftId: randomUUID(), revision: randomUUID(),
      source: { nodeId: randomUUID(), canonicalURL: target.binding.canonicalURL, mediaInfo: target.binding.mediaInfo }, inputs: [], params },
    analysis_refs: [], presentation_ref: target.presented.presentationRef, outputs: [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: recipe } }] } as unknown as Fixture["body"];
}

/**
 * Seed an erase request over a range with its tracked mask analysis.
 * @param range - The erase range in seconds.
 * @param options - The anchor, the analysis status and whether the source is transparent.
 * @param options.anchorFrame - The anchor's presentation frame.
 * @param options.status - The tracking analysis status.
 * @param options.transparent - A transparent source.
 * @returns The fixture.
 * @throws {Error} On fixture SQL failure or an invalid analysis fixture.
 */
async function seedErase(range: Range, options: { anchorFrame?: number; status?: "completed" | "running"; transparent?: boolean } = {}): Promise<Fixture> {
  const target = await seedSource(options);
  const anchorFrame = options.anchorFrame ?? Math.round(range.start * 200);
  const params = { range, anchor: { frameIndex: anchorFrame, pts: anchorFrame / 200 }, region: { box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, points: [] }, trackingPrompt: "" };
  const body = request(target, "video.erase", params, "erase");
  const analysisRunId = randomUUID(); const revision = randomUUID(); const rleId = randomUUID(); const rleKey = `document/erase/${rleId}.json`;
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id)
    VALUES (${rleId},${target.studioId},${randomBytes(32).toString("hex")},${rleKey},${publicUrl(rleKey)},2048,'text/plain','document','generated',${target.userId})`;
  const analysisInput = projectMiniToolAnalysisInput({ kind: "tracked_mask", source: body.draft.source, params, profile: TRACKED_PROFILE });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const frames = Math.round((range.end - range.start) * 200);
  const identity = { schemaVersion: 1 as const, draftId: body.draft.draftId, revision, kind: "tracked_mask" as const, analysisRunId, acceptedAt: ACCEPTED_AT, binding: target.binding, analysisInput, inputFingerprint };
  const result = { ...identity, width: 960, height: 540, frameCount: frames, timeBase: { numerator: 1, denominator: 200 }, anchor: params.anchor, regionFingerprint: "c".repeat(64),
    sourceFrameMapping: Array.from({ length: frames }, (_unused, frameIndex) => ({ frameIndex, sourcePts: range.start + frameIndex / 200 })),
    artifactRefs: [{ role: "rle", assetId: rleId, canonicalURL: publicUrl(rleKey), contentHash: "d".repeat(64), kind: "document", mimeType: "text/plain", size: 2048, frameMetadata: null }] };
  const status = options.status ?? "completed";
  const record = miniToolAnalysisRecordSchema.parse({ ...identity, status, result: status === "completed" ? result : null, error: null, usage: [], artifactUnavailable: false });
  const analysis = miniToolFrozenAnalysisSchema.parse({ schemaVersion: 1, analysisRunId, projectId: target.projectId, spaceId: body.space_id as string, hostNodeId: body.draft.source.nodeId,
    draftId: body.draft.draftId, revision, kind: "tracked_mask", source: body.draft.source, binding: target.binding, analysisInput, inputFingerprint,
    presentationRef: target.presented.presentationRef, ledgerReceipts: { source: target.presented.receipt }, versionIds: { source: target.presented.versionId } });
  const taskParams = { analysis, requestFingerprint: randomBytes(32).toString("hex"), sourceKey: target.sourceKey, credits: 0 };
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result,created_at)
    VALUES (${analysisRunId},${target.userId},${target.projectId},${body.space_id as string},'mini_tool_analysis','append','mini_tool',${status},
      ${pg.json(z.json().parse(taskParams))},${pg.json(z.json().parse({ analysis: record }))},${ACCEPTED_AT}::text::timestamptz)`;
  body.analysis_refs = [{ version: 1, draftId: body.draft.draftId, analysisRunId, inputFingerprint, toolId: "video.erase", kind: "tracked_mask" }];
  return { ...target, body, analysisRunId };
}

/**
 * Seed an expand request.
 * @param frame - The expansion frame.
 * @param options - Whether the source is transparent and the draft's prompt.
 * @param options.transparent - A transparent source.
 * @param options.prompt - The draft prompt.
 * @returns The fixture.
 * @throws {Error} On fixture SQL failure.
 */
async function seedExpand(frame: Frame, options: { transparent?: boolean; prompt?: string } = {}): Promise<Fixture> {
  const target = await seedSource(options);
  return { ...target, body: request(target, "video.expand", { frame, ratio: "free", prompt: options.prompt ?? "" }, "expand") };
}

/** Drive the real HTTP auth, idempotency, validation and planned startup. @throws {Error} On session storage or client failure. */
async function post(f: Fixture, body: unknown = f.body): Promise<Response> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, f.userId);
  return app.request("/api/v1/mini-tools", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID(), Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(body) });
}

/** Require a real admission and return the frozen plan. @throws {Error} On assertion failure. */
async function accept(f: Fixture): Promise<Plan> {
  const response = await post(f);
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 201, body: { data: { task_id: f.body.run_id, status: "pending" } } });
  const [row] = await pg<{ params: { miniToolExecution: Plan } }[]>`SELECT params FROM tasks WHERE id=${f.body.run_id}`;
  if (!row) throw new Error("Missing accepted task");
  return row.params.miniToolExecution;
}

/** Count only this run's original owners. @throws {Error} On SQL or queue failure. */
async function effects(id: string): Promise<{ tasks: number; rows: number; holds: number; jobs: number }> {
  const [count] = await pg<{ tasks: number; rows: number; holds: number }[]>`SELECT
    (SELECT count(*)::int FROM tasks WHERE id=${id}) AS tasks,
    (SELECT count(*)::int FROM node_tasks WHERE task_id=${id}) AS rows,
    (SELECT count(*)::int FROM credit_holds WHERE reference_id=${id}) AS holds`;
  if (!count) throw new Error("Missing count projection");
  return { ...count, jobs: await queue.getJob(id) ? 1 : 0 };
}

/**
 * Require a 400 refusal that tells the user why and no durable effect.
 * @param f - The fixture.
 * @param key - The user-facing message key.
 * @param params - Its ICU values.
 * @returns Nothing.
 * @throws {Error} On assertion failure.
 */
async function refused(f: Fixture, key: string, params?: Record<string, number>): Promise<void> {
  const response = await post(f);
  const json = await response.json() as { error?: { message?: string; reason?: string } };
  expect({ status: response.status, reason: json.error?.reason, message: json.error?.message }).toEqual({ status: 400, reason: undefined, message: shared.t(key, params) });
  expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
}

/**
 * The presented frames of a range of the fixture source, in seconds.
 * @param range - The range.
 * @returns Its frames.
 * @throws {RangeError} Never for ranges inside the source.
 */
function framesOf(range: Range): Range[] {
  return Array.from({ length: Math.round((range.end - range.start) * 200) }, (_unused, at) => {
    const frame = presentationFrameAt(REMOVAL_TABLE as VideoPresentationTable, Math.round(range.start * 200) + at);
    return { start: frame.pts, end: frame.displayEnd };
  });
}

describe("erase fresh admission (execution design §10.4)", () => {
  it("EA01 admits a 3 s range over one completed tracked mask, freezing the 30 fps grid and Bria's price for it", async () => {
    const f = await seedErase({ start: 1, end: 4 });
    const plan = await accept(f);
    const grid = planners.modelGrid(framesOf({ start: 1, end: 4 }), 30);
    expect(grid).toEqual({ mode: "resample", rate: 30, frameCount: 90 });
    expect(plan).toMatchObject({ tool: "video.erase", model: BRIA, grid });
    expect(plan.modelCredits).toBe(await estimateTaskCredits(BRIA, { params: {}, durations: { video: [3] }, sources: ["video"] }));
    expect(plan.credits).toBeGreaterThan(plan.modelCredits!);
  });

  it("EA02 admits a range of exactly 5 s and refuses one whose grid lasts longer, or one under 1 s", async () => {
    await accept(await seedErase({ start: 0, end: 5 }));
    await refused(await seedErase({ start: 0, end: 5.055 }), "server.mini_tool.eraseRange", { min: 1, max: 5 });
    await refused(await seedErase({ start: 0, end: 0.9 }), "server.mini_tool.eraseRange", { min: 1, max: 5 });
  });

  it("EA03 refuses an anchor outside the range", async () => {
    await refused(await seedErase({ start: 1, end: 3 }, { anchorFrame: 700 }), "server.mini_tool.anchorOutsideRange");
  });

  it("EA04 refuses while the tracking still runs", async () => {
    await refused(await seedErase({ start: 1, end: 3 }, { status: "running" }), "server.mini_tool.trackingRunning");
  });

  it("EA05 refuses a tracking analysis made for another selection", async () => {
    const f = await seedErase({ start: 1, end: 3 });
    f.body.draft.params = { ...f.body.draft.params, region: { box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }, points: [] } };
    await refused(f, "server.mini_tool.trackingStale");
  });

  it("EA07 quotes and admits over a tracking made before the configured tracking profile changed", async () => {
    const f = await seedErase({ start: 1, end: 3 });
    settings.analyses.tracked_mask.profile = { ...TRACKED_PROFILE, version: "wavespeed-ai/sam3-video-rle-next", params: { ...TRACKED_PROFILE.params, default_prompt: "thing" } };
    const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, f.userId);
    const quote = await app.request("/api/v1/mini-tools/quote", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(f.body) });
    expect({ status: quote.status, body: await quote.text() }).toMatchObject({ status: 200 });
    await accept(f);
  });

  it("EA06 refuses a transparent source", async () => {
    await refused(await seedErase({ start: 1, end: 3 }, { transparent: true }), "server.mini_tool.transparentSource");
  });

  // inner#1306 test plan §67.2 A04 (frames-split §5.4 派发行: the erase preparation is one job, never chunked, and is in the
  // 「任一作业超过一个块份额时受理拒绝」 check; §10.12 execution-admission.service.ts row 「擦除准备（:633）加进……检查」). The
  // share holds a few composite frames per chunk (so the composite stage fits the raised cap) but not the 3 s preparation.
  it("A04 refuses an erase whose single preparation job exceeds one chunk share, telling the user, with no durable effect", async () => {
    const f = await seedErase({ start: 1, end: 4 });
    settings.encoding.encoder.encode_pixels_per_second = 960 * 540;
    settings.encoding.max_parallel_chunks = 100_000;
    settings.encoding.chunk_share = (settings.encoding.encoder.start_seconds + 4) / (core.getNodeTaskConfig().default_budget_ms / 1000);
    const response = await post(f);
    const json = await response.json() as { error?: { message?: string } };
    expect(response.status).toBe(400);
    expect(json.error?.message).toEqual(expect.any(String));
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
});

describe("expand fresh admission (execution design §10.5)", () => {
  const WIDER: Frame = { x: -0.25, y: 0, width: 1.5, height: 1 };

  it("EX01 freezes the even layout, the default prompt, a seed and one 10 s window priced by VACE's tier", async () => {
    const plan = await accept(await seedExpand(WIDER));
    expect(plan.layout).toEqual(planners.videoExpandLayout(WIDER, { width: 960, height: 540 }, 4096));
    expect(plan.prompt).toBe(miniTools.miniToolById("video.expand")?.prompt?.defaultText);
    expect(typeof plan.seed).toBe("number");
    const windows = planners.planModelWindows(framesOf({ start: 0, end: V }));
    expect(plan.windows).toEqual(windows);
    expect(windows.map(window => window.duration)).toEqual([10]);
    expect(plan.modelCredits).toBe(await estimateTaskCredits(VACE, { params: { duration: 10 }, durations: { video: [10] }, sources: ["video"] }));
    expect(plan.credits).toBeGreaterThan(plan.modelCredits!);
  });

  it("EX02 keeps the user's prompt when one is written", async () => {
    expect((await accept(await seedExpand(WIDER, { prompt: "a quiet beach" }))).prompt).toBe("a quiet beach");
  });

  it("EX03 refuses a target whose long side passes max_target_side", async () => {
    await refused(await seedExpand({ x: -1.65, y: 0, width: 4.3, height: 1 }), "server.mini_tool.expandTooLarge", { max: 4096 });
  });

  it("EX04 refuses a source longer than max_duration_seconds", async () => {
    Reflect.set(settings.executions, "video.expand", { ...executions()["video.expand"] as Record<string, unknown>, max_duration_seconds: 5 });
    await refused(await seedExpand(WIDER), "server.mini_tool.expandTooLong", { max: 5 });
  });

  it("EX05 refuses a transparent source", async () => {
    await refused(await seedExpand(WIDER, { transparent: true }), "server.mini_tool.transparentSource");
  });
});

// Execution design §10.4 and §10.5 quote rows: admission freezes a quote per step (generate is the model's price, each
// container step its own share), the run's quote is their sum, and a retry holds only the steps not done on the original
// chain. A done step is one whose object the original's execution pin holds, as the worker pins it in the transaction that
// records the step (§7.15); the retry reuses exactly those (§7.11 retry row).
describe("erase and expand retry quote (execution design §10.4, §10.5 quote rows)", () => {
  /** The sum of credit figures, settled to the cent. @param values - The figures. @returns The sum. */
  const sum = (values: number[]): number => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

  /**
   * Admit, mark `done` steps done as the worker leaves them, end the run failed on `reason`, and retry its output.
   * @param f - The fixture.
   * @param done - The step names done on the original.
   * @param reason - The original's failure reason.
   * @returns The original's and the retry's frozen plans and the retry's hold.
   * @throws {Error} On admission, completion or fixture SQL failure.
   */
  async function retryAfter(f: Fixture, done: (keys: Record<string, string>) => string[], reason: Record<string, unknown>): Promise<{ original: Plan; retried: Plan; hold: number }> {
    const original = await accept(f);
    const id = f.body.run_id;
    const keys = original.stepKeys!;
    await miniToolExecutionService.startMiniToolExecution(id, `retry-quote-${id}`);
    const sourceKey = String(original.sourceKey);
    // Container outputs carry `<task>:<stepKey>:a<n>` in their work key; a generate object is `<stepKey>:<attempt>` (§97 D17-6).
    const objects = done(keys).map((step) => (step.startsWith("generate") ? `${keys[step]}:${randomUUID()}` : `${sourceKey}.${id}:${keys[step]}:a1.mp4`));
    await core.db.transaction(async (tx) => appendExecutionPinObjects(id, objects, tx));
    const error = z.record(z.string(), z.json()).parse(reason);
    const outputs = original.outputs as { outputIndex: number; nodeId: string; recipe: { kind: "erase" | "expand" } }[];
    await miniToolExecutionService.finishMiniToolExecution(id, { planFingerprint: String(original.planFingerprint), expectedVersion: 0,
      error, outputs: outputs.map((output) => ({ ...output, late: false, result: { status: "failed", error } })) });
    await pg`UPDATE node_tasks SET status='failed',settled_at=clock_timestamp() WHERE task_id=${id}`;
    await creditHoldService.releaseHold(id);
    const retry = { tool: f.body.tool, project_id: f.body.project_id, space_id: f.body.space_id, run_id: randomUUID(), retry: { runId: id, outputIndexes: [0] } };
    const response = await post(f, retry);
    expect(response.status, await response.clone().text()).toBe(201);
    const [row] = await pg<{ params: { miniToolExecution: Plan } }[]>`SELECT params FROM tasks WHERE id=${retry.run_id}`;
    const [hold] = await pg<{ amount: number }[]>`SELECT amount::float8 FROM credit_holds WHERE reference_id=${retry.run_id}`;
    return { original, retried: row!.params.miniToolExecution, hold: hold!.amount };
  }

  it("RQ01 an erase freezes one quote per step summing to its quote, and its retry after a done generate holds only composite and stitch", async () => {
    const f = await seedErase({ start: 1, end: 4 });
    const { original, retried, hold } = await retryAfter(f, () => ["prepare", "mask", "generate"], { kind: "erase", step: "composite", category: "failed" });
    const steps = original.stepCredits!;
    expect(Object.keys(steps)).toEqual(Object.keys(original.stepKeys!));
    expect(steps.generate).toBe(original.modelCredits);
    expect(original.credits).toBe(sum(Object.values(steps)));
    const remaining = sum(Object.entries(steps).filter(([step]) => step.startsWith("composite:") || step === "stitch").map(([, credits]) => credits));
    expect(retried.credits).toBe(remaining);
    expect(hold).toBe(remaining);
    expect(retried.credits).toBeLessThan(original.credits);
  });

  it("RQ02 an expand freezes each window's VACE price and container jobs, and its retry after a done first window holds only what is left", async () => {
    const f = await seedExpand({ x: -0.25, y: 0, width: 1.5, height: 1 });
    const { original, retried, hold } = await retryAfter(f, () => ["window:0", "window_mask:0", "generate:0"], { kind: "expand", windows: [], shared: { step: "composite", category: "failed" } });
    const steps = original.stepCredits!;
    expect(Object.keys(steps)).toEqual(Object.keys(original.stepKeys!));
    expect(sum(Object.entries(steps).filter(([step]) => step.startsWith("generate:")).map(([, credits]) => credits))).toBe(original.modelCredits);
    expect(original.credits).toBe(sum(Object.values(steps)));
    const remaining = sum(Object.entries(steps).filter(([step]) => !["window:0", "window_mask:0", "generate:0"].includes(step)).map(([, credits]) => credits));
    expect(retried.credits).toBe(remaining);
    expect(hold).toBe(remaining);
    expect(retried.credits).toBeLessThan(original.credits);
  });
});
