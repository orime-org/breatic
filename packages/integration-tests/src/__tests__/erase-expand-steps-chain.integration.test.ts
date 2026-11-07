// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The erase and expand step chains from a real admission to the run's end (inner#1306 execution design §10.4, §10.5,
 * §10.7): the run is admitted through the server app, its frozen execution is read back with
 * `miniToolExecutionService.startMiniToolExecution`, and the worker runners `runMiniToolErase` / `runMiniToolExpand` (loaded
 * by name, the lip-sync runner's shape) are driven pickup by pickup.
 *
 * Real PostgreSQL admission, steps, attempts, pins and registration. The controlled external IO: the presentation snapshot
 * at ingest and the stored ledger objects; WaveSpeed `runPrediction`; the ingest Worker's link fetch `fetchUrlToIngest`; the
 * ingest `/jobs` boundary (every job done at once unless a case scripts it).
 *
 * What is asserted, at those boundaries:
 * - erase: `prepare_model_input` with the frozen 30 fps grid, `bria_mask` over the tracked RLE with the same grid, one Bria
 *   request `{ video, mask_video, copy_audio: false }` on their outputs, erase composite chunks reading the Bria result and
 *   the RLE with the grid and the configured matte, one stitch; Bria's async code 1401 and a composite
 *   `model_output_mismatch` end the run with `{ kind: "erase", step, category }`.
 * - expand: per window `model_window` and `model_window_mask` on the 16 fps grid in the standard 832x480 frame, a
 *   `frame_at` condition from the previous window's result for every later window, one VACE request per window with the
 *   fixed parameters, the frozen seed and the resolved prompt, the composite cropping each background to `targetRoi`;
 *   a VACE refusal stops the later windows.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import type * as sharedModule from "@breatic/shared";
import { miniToolExecutionService, miniToolFrozenAnalysisSchema, taskRepo } from "@breatic/domain";
import { fingerprintMiniToolAnalysisInput, miniToolAnalysisRecordSchema, miniToolById, projectMiniToolAnalysisInput, type MiniToolAnalysisRecord } from "@breatic/shared/mini-tools";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { presentedSource, type PresentedSource } from "@server/__tests__/integration/presentation-fixtures.js";
import { INGEST_ENV } from "./ingest-jobs-fake.js";

const outside = vi.hoisted(() => ({ runPrediction: vi.fn(), fetchUrl: vi.fn(), ingest: vi.fn(), snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), config: vi.fn() }));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction: outside.runPrediction }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof sharedModule>(), fetchUrlToIngest: outside.fetchUrl, videoPresentationAtIngest: outside.ingest }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), getMiniToolsConfig: outside.config }));

type Runner = (execution: unknown, userId: string, deadlineAt: number) => Promise<{ results: Map<number, Record<string, unknown>>; waiting: boolean }>;
/** A runner loaded by name. @param module - Its module. @param name - Its export. @returns It. */
const runnerOf = async (module: string, name: string): Promise<Runner> => ((await import(/* @vite-ignore */ module)) as Record<string, Runner>)[name]!;

interface Job { jobId: string; containerClass: string; inputs: { inputId: string; storageKey: string }[]; outputs: { outputIndex: number; storageKey: string; contentType: string; recipe: Record<string, unknown> }[] }
interface Fixture extends StudioFixture { body: Record<string, unknown> & { run_id: string }; rleKey?: string }

const BRIA = "bria-video-eraser-mask";
const VACE = "wan-2.1-14b-vace";
// The provider endpoints the two catalog models route to (measured in the §8 and §10.1 probes).
const BRIA_ENDPOINT = "bria/video-eraser/mask";
const VACE_ENDPOINT = "wavespeed-ai/wan-2.1-14b-vace";
const TRACKED_PROFILE = { id: "sam3-video-rle", version: "wavespeed-ai/sam3-video-rle", weightsHash: null, params: { apply_mask: false, default_prompt: "object" } };
const V = 5.055;
const ACCEPTED_AT = "2026-11-07T09:00:00.123456Z";

let pg: ReturnType<typeof core.createPgClient>;
let app: { request: (path: string, init: RequestInit) => Promise<Response> };
let base: core.MiniToolsConfig;
let settings: core.MiniToolsConfig;
let publicUrl: (key: string) => string;
let submitted: Job[];
let scripted: Map<string, Record<string, unknown>>;
// Per-model provider behaviour, keyed by the model and an index of its calls.
let fault: (model: string, call: number) => unknown;
const tokens: string[] = [];

/** Inject dummy external credentials only. @throws {Error} On invalid fixture configuration. */
function configure(): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "fixture-never-sent", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
}

/**
 * The §10.6 execution blocks.
 * @param expandWindow - The expand window length.
 * @returns The blocks.
 */
function executions(expandWindow = 10): Record<string, unknown> {
  return {
    "video.erase": { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1,
      model: { name: BRIA, min_seconds: 1, max_seconds: 5, max_grid_fps: 30, async_rejection: { path: "code", equals: 1401 } }, matte: { dilate: 4, feather: 4 } },
    "video.expand": { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1,
      model: { name: VACE, max_window_seconds: expandWindow, overlap_seconds: 0.625, model_fps: 16 }, max_duration_seconds: 180, max_target_side: 4096 },
  };
}

/**
 * A done report for a job: every declared output written.
 * @param request - The job.
 * @returns The report.
 */
function done(request: Job): Record<string, unknown> {
  return { schemaVersion: 2, state: "done", usage: { wallMs: 1000, cpuUsec: 2000000 }, outputs: request.outputs.map((output) => ({
    outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType,
    ...(output.contentType.startsWith("video/") ? { width: 960, height: 540, durationSeconds: 3, cover: null, upright: null } : {}) })) };
}

beforeAll(async () => {
  configure(); core.loadLocales(); core.initLogger("erase-expand-chain-test");
  const actual = await vi.importActual<typeof core>("@breatic/core");
  base = structuredClone(actual.getMiniToolsConfig());
  pg = core.createPgClient(inject("DATABASE_URL"), { name: "erase-expand-chain", max: 6 });
  const storage = await core.getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
  app = (await import("@server/app.js")).createApp();
});
beforeEach(() => {
  vi.clearAllMocks(); configure();
  settings = structuredClone(base);
  for (const [tool, block] of Object.entries(executions())) Reflect.set(settings.executions, tool, block);
  outside.config.mockImplementation(() => settings);
  submitted = []; scripted = new Map(); fault = () => undefined;
  outside.snapshots.clear(); outside.bodies.clear();
  outside.ingest.mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    const snapshot = outside.snapshots.get(input.storageKey);
    if (input.action !== "read" || !snapshot) throw new Error(`Unexpected presentation admission ${input.action}`);
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Job; submitted.push(request);
      return Response.json(scripted.get(request.jobId) ?? done(request));
    }
    if (url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const request = submitted.find((candidate) => candidate.jobId === id);
      return request === undefined ? new Response("missing", { status: 404 }) : Response.json(scripted.get(id) ?? done(request));
    }
    const body = outside.bodies.get(url.href);
    if (body !== undefined) return new Response(body, { headers: { "content-type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  }));
  const calls = new Map<string, number>();
  outside.runPrediction.mockImplementation(async (_connection: unknown, model: string, _body: Record<string, unknown>, resume: { storedTaskId: string | null; persistTaskId: (id: string) => Promise<void> }) => {
    const call = calls.get(model) ?? 0; calls.set(model, call + 1);
    const failure = fault(model, call);
    if (failure !== undefined) throw failure;
    const id = resume.storedTaskId ?? randomUUID();
    if (resume.storedTaskId === null) await resume.persistTaskId(id);
    return { taskId: id, outputs: [`https://provider.example.test/${model}/${call}.mp4`] };
  });
  outside.fetchUrl.mockImplementation(async () => ({ sha256: "8".repeat(64), sizeBytes: 4096, contentType: "video/mp4" }));
});
afterAll(async () => {
  for (const token of tokens) await core.revokeSession(core.getRedis(), token);
  await pg.end(); core.initCore(process.env); vi.unstubAllGlobals();
});

/**
 * Register the presented source and fund the Studio.
 * @returns The source's parts.
 * @throws {Error} On fixture SQL failure.
 */
async function seedSource(): Promise<StudioFixture & { sourceKey: string; presented: PresentedSource; binding: MiniToolAnalysisRecord["binding"] }> {
  const target = await seedStudioFixture(pg, "erase-chain");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
  await seedDesignatedLot(pg, target, 1000);
  const sourceId = randomUUID(); const sourceKey = `video/erase-chain/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
  const presented = await presentedSource(hash, sourceKey, publicUrl);
  outside.snapshots.set(sourceKey, presented.snapshot);
  for (const [url, body] of presented.bodies) outside.bodies.set(url, body);
  return { ...target, sourceKey, presented, binding: { assetId: sourceId, contentHash: hash, canonicalURL: publicUrl(sourceKey), kind: "video", mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } } };
}

/**
 * A planned request body around a draft.
 * @param target - The seeded source.
 * @param tool - The tool.
 * @param params - The draft parameters.
 * @param recipe - The output recipe kind.
 * @returns The body.
 */
function request(target: Awaited<ReturnType<typeof seedSource>>, tool: string, params: Record<string, unknown>, recipe: string): Fixture["body"] {
  return { tool, project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
    draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: randomUUID(), canonicalURL: target.binding.canonicalURL, mediaInfo: target.binding.mediaInfo }, inputs: [], params },
    analysis_refs: [], presentation_ref: target.presented.presentationRef, outputs: [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: recipe } }] };
}

/**
 * An erase over [1, 4) s anchored on its first frame, with its completed tracked mask analysis.
 * @returns The fixture.
 * @throws {Error} On fixture failure.
 */
async function seedErase(): Promise<Fixture> {
  const target = await seedSource();
  const params = { range: { start: 1, end: 4 }, anchor: { frameIndex: 200, pts: 1 }, region: { box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, points: [] }, trackingPrompt: "" };
  const body = request(target, "video.erase", params, "erase");
  const draft = body.draft as { draftId: string; source: { nodeId: string; canonicalURL: string } };
  const analysisRunId = randomUUID(); const revision = randomUUID(); const rleId = randomUUID(); const rleKey = `document/erase-chain/${rleId}.json`;
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id)
    VALUES (${rleId},${target.studioId},${randomBytes(32).toString("hex")},${rleKey},${publicUrl(rleKey)},2048,'text/plain','document','generated',${target.userId})`;
  const analysisInput = projectMiniToolAnalysisInput({ kind: "tracked_mask", source: draft.source, params, profile: TRACKED_PROFILE });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const identity = { schemaVersion: 1 as const, draftId: draft.draftId, revision, kind: "tracked_mask" as const, analysisRunId, acceptedAt: ACCEPTED_AT, binding: target.binding, analysisInput, inputFingerprint };
  const result = { ...identity, width: 960, height: 540, frameCount: 600, timeBase: { numerator: 1, denominator: 200 }, anchor: params.anchor, regionFingerprint: "c".repeat(64),
    sourceFrameMapping: Array.from({ length: 600 }, (_unused, frameIndex) => ({ frameIndex, sourcePts: 1 + frameIndex / 200 })),
    artifactRefs: [{ role: "rle", assetId: rleId, canonicalURL: publicUrl(rleKey), contentHash: "d".repeat(64), kind: "document", mimeType: "text/plain", size: 2048, frameMetadata: null }] };
  const record = miniToolAnalysisRecordSchema.parse({ ...identity, status: "completed", result, error: null, usage: [], artifactUnavailable: false });
  const analysis = miniToolFrozenAnalysisSchema.parse({ schemaVersion: 1, analysisRunId, projectId: target.projectId, spaceId: body.space_id, hostNodeId: draft.source.nodeId,
    draftId: draft.draftId, revision, kind: "tracked_mask", source: draft.source, binding: target.binding, analysisInput, inputFingerprint,
    presentationRef: target.presented.presentationRef, ledgerReceipts: { source: target.presented.receipt }, versionIds: { source: target.presented.versionId } });
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result,created_at)
    VALUES (${analysisRunId},${target.userId},${target.projectId},${String(body.space_id)},'mini_tool_analysis','append','mini_tool','completed',
      ${pg.json({ analysis, requestFingerprint: randomBytes(32).toString("hex"), sourceKey: target.sourceKey, credits: 0 })},${pg.json({ analysis: record })},${ACCEPTED_AT}::text::timestamptz)`;
  body.analysis_refs = [{ version: 1, draftId: draft.draftId, analysisRunId, inputFingerprint, toolId: "video.erase", kind: "tracked_mask" }];
  return { ...target, body, rleKey };
}

/**
 * An expand of the whole source to 1440x540.
 * @returns The fixture.
 * @throws {Error} On fixture failure.
 */
async function seedExpand(): Promise<Fixture> {
  const target = await seedSource();
  return { ...target, body: request(target, "video.expand", { frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, ratio: "free", prompt: "" }, "expand") };
}

/**
 * Admit through the server app, then drive the worker runner until the one output ends.
 * @param f - The fixture.
 * @param module - The runner's module.
 * @param name - The runner's export.
 * @returns The frozen plan and the output's result.
 * @throws {Error} When admission refuses or the run never ends.
 */
async function admitAndDrive(f: Fixture, module: string, name: string): Promise<{ plan: Record<string, unknown>; result: Record<string, unknown> }> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, f.userId);
  const response = await app.request("/api/v1/mini-tools", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID(), Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(f.body) });
  expect(response.status, await response.clone().text()).toBe(201);
  const { task, execution } = await miniToolExecutionService.startMiniToolExecution(f.body.run_id, f.body.run_id);
  const stored = await taskRepo.getMiniToolExecutionTask(task.id);
  const deadlineAt = await taskDeadline(task.id, stored!.createdAt);
  const run = await runnerOf(module, name);
  for (let pickup = 0; pickup < 60; pickup += 1) {
    try {
      const answer = await run(execution, task.userId, deadlineAt);
      const result = answer.results.get(0);
      if (result !== undefined) return { plan: execution as unknown as Record<string, unknown>, result };
    } catch (error) { if (!(error instanceof StillRunning)) throw error; }
  }
  throw new Error("The run never ended");
}

/**
 * Every first-attempt job of one recipe kind.
 * @param kind - The recipe kind.
 * @returns The jobs in submission order.
 */
function jobsOf(kind: string): Job[] {
  const seen = new Set<string>();
  return submitted.filter((job) => job.outputs[0]?.recipe.kind === kind).filter((job) => { const step = job.jobId.replace(/\d+$/, ""); if (seen.has(step)) return false; seen.add(step); return true; });
}

/**
 * The storage key a job binds an input id to.
 * @param job - The job.
 * @param inputId - The recipe's input id.
 * @returns The key.
 */
function bound(job: Job, inputId: unknown): string | undefined {
  return job.inputs.find((input) => input.inputId === inputId)?.storageKey;
}

/**
 * The provider requests to one endpoint, in call order.
 * @param endpoint - The provider endpoint.
 * @returns Their bodies.
 */
function calls(endpoint: string): Record<string, unknown>[] {
  return outside.runPrediction.mock.calls.filter((call) => call[1] === endpoint).map((call) => call[2] as Record<string, unknown>);
}

describe("the erase chain (execution design §10.4 steps and composite rows)", () => {
  it("EC01 prepares on the frozen grid, masks the RLE on it, asks Bria once and composites its result through the RLE matte", async () => {
    const f = await seedErase();
    const { plan, result } = await admitAndDrive(f, "@worker/handlers/mini-tool/run-erase.js", "runMiniToolErase");
    expect(result).toMatchObject({ status: "registered", kind: "video" });
    const grid = { mode: "resample", rate: 30, frameCount: 90 };
    expect(plan.grid).toEqual(grid);
    const [prepare] = jobsOf("prepare_model_input");
    expect(jobsOf("prepare_model_input")).toHaveLength(1);
    expect(prepare!.outputs[0]!.recipe).toMatchObject({ grid, window: { start: 200, end: 800 } });
    expect(prepare!.outputs[0]!.recipe.target).toMatchObject({ alpha: "none" });
    const [mask] = jobsOf("bria_mask");
    expect(jobsOf("bria_mask")).toHaveLength(1);
    expect(mask!.outputs[0]!.recipe).toMatchObject({ range: { startFrame: 200, frameCount: 600 }, grid });
    expect(bound(mask!, mask!.outputs[0]!.recipe.inputId)).toBe(f.rleKey);
    const bria = calls(BRIA_ENDPOINT);
    expect(bria).toEqual([{ video: publicUrl(prepare!.outputs[0]!.storageKey), mask_video: publicUrl(mask!.outputs[0]!.storageKey), copy_audio: false }]);
    const composites = jobsOf("model_composite");
    expect(composites.length).toBeGreaterThan(0);
    for (const job of composites) {
      const recipe = job.outputs[0]!.recipe;
      expect(recipe).toMatchObject({ mode: "erase", range: { startFrame: 200, frameCount: 600 }, grid, matte: { dilate: 4, feather: 4 } });
      expect(bound(job, recipe.rle)).toBe(f.rleKey);
    }
    expect(jobsOf("stitch")).toHaveLength(1);
  });

  it("EC02 Bria's asynchronous code 1401 ends the run as generate / model_rejected", async () => {
    fault = (model) => (model === BRIA_ENDPOINT ? Object.assign(new UpstreamTaskFailed("wavespeed", '{"code":1401}'), { structuredError: { code: 1401 } }) : undefined);
    const { result } = await admitAndDrive(await seedErase(), "@worker/handlers/mini-tool/run-erase.js", "runMiniToolErase");
    expect(result).toMatchObject({ status: "failed", error: { kind: "erase", step: "generate", category: "model_rejected" } });
  });

  it("EC03 a composite whose result frame count differs ends the run as composite / model_output_mismatch", async () => {
    const f = await seedErase();
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = await original(input, init);
      const job = init?.method === "POST" && String(input).endsWith("/jobs") ? JSON.parse(String(init.body)) as Job : null;
      if (job?.outputs[0]?.recipe.kind === "model_composite") scripted.set(job.jobId, { schemaVersion: 2, state: "failed", reason: "model_output_mismatch", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } });
      return job !== null && scripted.has(job.jobId) ? Response.json(scripted.get(job.jobId)) : response;
    });
    const { result } = await admitAndDrive(f, "@worker/handlers/mini-tool/run-erase.js", "runMiniToolErase");
    expect(result).toMatchObject({ status: "failed", error: { kind: "erase", step: "composite", category: "model_output_mismatch" } });
  });
});

describe("the expand chain (execution design §10.5 steps, model and composite rows)", () => {
  it("XC01 one window: the 16 fps window and mask in the 832x480 frame, one VACE request with the fixed parameters, the composite cropping to targetRoi", async () => {
    const { plan, result } = await admitAndDrive(await seedExpand(), "@worker/handlers/mini-tool/run-expand.js", "runMiniToolExpand");
    expect(result).toMatchObject({ status: "registered", kind: "video" });
    const [window] = jobsOf("model_window"); const [mask] = jobsOf("model_window_mask");
    expect(jobsOf("model_window")).toHaveLength(1); expect(jobsOf("model_window_mask")).toHaveLength(1);
    for (const job of [window!, mask!]) expect(job.outputs[0]!.recipe).toMatchObject({ grid: { fps: 16, frameCount: 160 }, frame: { width: 832, height: 480 }, sourceRoi: plan.sourceRoi });
    expect(window!.outputs[0]!.recipe).toMatchObject({ fill: [127, 127, 127] });
    expect(jobsOf("frame_at")).toEqual([]);
    const vace = calls(VACE_ENDPOINT);
    expect(vace).toHaveLength(1);
    expect(vace[0]).toMatchObject({ task: "inpainting", num_inference_steps: 30, guidance_scale: 5, flow_shift: 16, context_scale: 1, size: "832*480", duration: 10,
      seed: plan.seed, prompt: miniToolById("video.expand")?.prompt?.defaultText });
    expect(Object.values(vace[0]!)).toEqual(expect.arrayContaining([publicUrl(window!.outputs[0]!.storageKey), publicUrl(mask!.outputs[0]!.storageKey)]));
    const composites = jobsOf("model_composite");
    expect(composites.length).toBeGreaterThan(0);
    for (const job of composites) for (const background of job.outputs[0]!.recipe.backgrounds as { crop: unknown }[]) expect(background.crop).toEqual(plan.targetRoi);
    expect(jobsOf("stitch")).toHaveLength(1);
  });

  it("XC02 later windows take a frame_at condition from the previous window's result at their start offset", async () => {
    for (const [tool, block] of Object.entries(executions(3))) Reflect.set(settings.executions, tool, block);
    const { plan } = await admitAndDrive(await seedExpand(), "@worker/handlers/mini-tool/run-expand.js", "runMiniToolExpand");
    const windows = plan.windows as { span: { start: number; end: number } }[];
    expect(windows.length).toBeGreaterThan(1);
    const conditions = jobsOf("frame_at");
    expect(conditions).toHaveLength(windows.length - 1);
    const vace = calls(VACE_ENDPOINT);
    expect(vace).toHaveLength(windows.length);
    expect(vace[0]!.image).toBeUndefined();
    conditions.forEach((job, at) => {
      const recipe = job.outputs[0]!.recipe as { time: { numerator: string; denominator: string }; target: { width: number; height: number } };
      expect(Number(recipe.time.numerator) / Number(recipe.time.denominator)).toBeCloseTo(windows[at + 1]!.span.start - windows[at]!.span.start, 6);
      expect(recipe.target).toMatchObject({ width: 832, height: 480 });
      expect(vace[at + 1]!.image).toBe(publicUrl(job.outputs[0]!.storageKey));
    });
  });

  it("XC03 a VACE refusal on window 1 stops every later window", async () => {
    for (const [tool, block] of Object.entries(executions(3))) Reflect.set(settings.executions, tool, block);
    fault = (model, call) => (model === VACE_ENDPOINT && call === 1 ? new HttpStatusError("wavespeed", 422, "{}") : undefined);
    const { plan, result } = await admitAndDrive(await seedExpand(), "@worker/handlers/mini-tool/run-expand.js", "runMiniToolExpand");
    const count = (plan.windows as unknown[]).length;
    expect(result).toMatchObject({ status: "failed", error: { kind: "expand", shared: null,
      windows: [{ windowIndex: 1, step: "generate", category: "model_rejected" }, ...Array.from({ length: count - 2 }, (_unused, at) => ({ windowIndex: at + 2, step: "generate", category: "stopped" }))] } });
    expect(calls(VACE_ENDPOINT)).toHaveLength(2);
  });
});
