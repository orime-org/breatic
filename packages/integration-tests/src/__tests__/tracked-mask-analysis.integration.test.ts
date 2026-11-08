// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The tracked mask analysis executor (inner#1306 execution design §10.2, §10.3): `runMiniToolTrackedMaskAnalysis(execution,
 * deadlineAt)` (loaded by name) on an accepted analysis read back with `miniToolAnalysisService.startMiniToolAnalysisExecution`.
 *
 * Real PostgreSQL analysis row, steps, attempts, pins and registration. The controlled external IO: WaveSpeed
 * `runPrediction`; the ingest Worker's link fetch `fetchUrlToIngest`; the ingest `/jobs` boundary and the stored ledger
 * objects, faked at `fetch` (every job done at once unless a case scripts it).
 *
 * The analysis tracks [1, 3) s of the 200 fps presented source (frames [200, 600)) from the anchor at 1.5 s (frame 300):
 * - `prepare:fwd` over frames [300, 600) and `prepare:rev` over [200, 300] reversed, on standard-4;
 * - one SAM3 request per clip with the box on that clip's frame 0, the frozen tracking prompt ("object" for an empty one)
 *   and `apply_mask: false`;
 * - `join`, an `rle_join` over both RLEs, registered as the result's one `rle` artifact; its `empty_foreground` ends the
 *   analysis with `TrackedMaskFailed({ code: "empty_foreground", step: "join" })`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import type * as sharedModule from "@breatic/shared";
import { miniToolAnalysisService, miniToolFrozenAnalysisSchema, presentationPinService } from "@breatic/domain";
import { fingerprintMiniToolAnalysisInput, miniToolAnalysisRecordSchema, projectMiniToolAnalysisInput } from "@breatic/shared/mini-tools";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { seedStudioFixture, type StudioFixture } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { presentedSource } from "@server/__tests__/integration/presentation-fixtures.js";
import { INGEST_ENV } from "./ingest-jobs-fake.js";

const outside = vi.hoisted(() => ({ runPrediction: vi.fn(), fetchUrl: vi.fn(), config: vi.fn() }));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction: outside.runPrediction }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof sharedModule>(), fetchUrlToIngest: outside.fetchUrl }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), getMiniToolsConfig: outside.config }));

type Executor = (execution: unknown, deadlineAt: number) => Promise<Record<string, unknown>>;
const EXECUTOR = "@worker/handlers/mini-tool/run-tracked-mask.js";
/** The executor, loaded by name. @returns It. */
const executor = async (): Promise<Executor> => ((await import(/* @vite-ignore */ EXECUTOR)) as { runMiniToolTrackedMaskAnalysis: Executor }).runMiniToolTrackedMaskAnalysis;
const STEPS = "@worker/handlers/mini-tool/model-run-steps.js";

interface Job { jobId: string; containerClass: string; inputs: { inputId: string; storageKey: string }[]; outputs: { outputIndex: number; storageKey: string; contentType: string; recipe: Record<string, unknown> }[] }
interface Fixture extends StudioFixture { taskId: string }

const TRACKER = "wavespeed-ai/sam3-video-rle";
const PROFILE = { id: "sam3-video-rle", version: "wavespeed-ai/sam3-video-rle", weightsHash: null, params: { apply_mask: false, default_prompt: "object" } };
const V = 5.055;
const ACCEPTED_AT = "2026-11-07T10:00:00.123456Z";

let pg: ReturnType<typeof core.createPgClient>;
let base: core.MiniToolsConfig;
let publicUrl: (key: string) => string;
let submitted: Job[];
let scripted: Map<string, Record<string, unknown>>;
let ledgerBodies: Map<string, string>;

/** Inject dummy external credentials only. @throws {Error} On invalid fixture configuration. */
function configure(): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "fixture-never-sent", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
}

/**
 * A done report for a job: every declared output written.
 * @param request - The job.
 * @returns The report.
 */
function done(request: Job): Record<string, unknown> {
  return { schemaVersion: 2, state: "done", usage: { wallMs: 1000, cpuUsec: 2000000 }, outputs: request.outputs.map((output) => ({
    outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType,
    ...(output.contentType.startsWith("video/") ? { width: 960, height: 540, durationSeconds: 1.5, cover: null, upright: null } : {}) })) };
}

beforeAll(async () => {
  configure(); core.loadLocales();
  const actual = await vi.importActual<typeof core>("@breatic/core");
  base = structuredClone(actual.getMiniToolsConfig());
  pg = core.createPgClient(inject("DATABASE_URL"), { name: "tracked-mask-analysis", max: 6 });
  const storage = await core.getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => {
  vi.clearAllMocks(); configure();
  const settings = structuredClone(base);
  // §10.6: the tracking profile's default prompt and its standard-4 preparation.
  Reflect.set(settings.analyses, "tracked_mask", { ...settings.analyses.tracked_mask, profile: PROFILE, preparation: { container_class: "MiniToolContainerStd4", precheck_seconds: 300 } });
  outside.config.mockImplementation(() => settings);
  submitted = []; scripted = new Map(); ledgerBodies = new Map();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Job; submitted.push(request);
      return Response.json(scripted.get(request.outputs[0]!.recipe.kind as string) ?? done(request));
    }
    if (url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const request = submitted.find((candidate) => candidate.jobId === id);
      return request === undefined ? new Response("missing", { status: 404 }) : Response.json(scripted.get(request.outputs[0]!.recipe.kind as string) ?? done(request));
    }
    const body = ledgerBodies.get(url.href);
    if (body !== undefined) return new Response(body, { headers: { "content-type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  }));
  outside.runPrediction.mockImplementation(async (_connection: unknown, _model: string, _body: Record<string, unknown>, resume: { storedTaskId: string | null; persistTaskId: (id: string) => Promise<void> }) => {
    const id = resume.storedTaskId ?? randomUUID();
    if (resume.storedTaskId === null) await resume.persistTaskId(id);
    return { taskId: id, outputs: [{ rle_url: `https://provider.example.test/rle/${id}.json`, video_url: `https://provider.example.test/preview/${id}.mp4` }] };
  });
  outside.fetchUrl.mockImplementation(async () => ({ sha256: "8".repeat(64), sizeBytes: 4096, contentType: "text/plain" }));
});
afterAll(async () => { await pg.end(); core.initCore(process.env); vi.unstubAllGlobals(); });

/**
 * An accepted tracked mask analysis of [1, 3) s anchored at 1.5 s, with an empty tracking prompt and its analysis pin.
 * @returns The fixture.
 * @throws {Error} On fixture failure.
 */
async function seed(): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "tracked-mask");
  const sourceId = randomUUID(); const sourceKey = `video/tracked-mask/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceId},${target.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${target.userId},960,540,${V})`;
  const presented = await presentedSource(hash, sourceKey, publicUrl);
  for (const [url, body] of presented.bodies) ledgerBodies.set(url, body);
  const binding = { assetId: sourceId, contentHash: hash, canonicalURL: publicUrl(sourceKey), kind: "video" as const, mediaInfo: { width: 960, height: 540, duration: V, mimeType: "video/mp4" } };
  const source = { nodeId: randomUUID(), canonicalURL: binding.canonicalURL, mediaInfo: binding.mediaInfo };
  const params = { range: { start: 1, end: 3 }, anchor: { frameIndex: 300, pts: 1.5 }, region: { box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, points: [] }, trackingPrompt: "" };
  const taskId = randomUUID(); const spaceId = randomUUID(); const draftId = randomUUID(); const revision = randomUUID();
  const analysisInput = projectMiniToolAnalysisInput({ kind: "tracked_mask", source, params, profile: PROFILE });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const identity = { schemaVersion: 1 as const, draftId, revision, kind: "tracked_mask" as const, analysisRunId: taskId, acceptedAt: ACCEPTED_AT, binding, analysisInput, inputFingerprint };
  const record = miniToolAnalysisRecordSchema.parse({ ...identity, status: "pending", result: null, error: null, usage: [], artifactUnavailable: false });
  const analysis = miniToolFrozenAnalysisSchema.parse({ schemaVersion: 1, analysisRunId: taskId, projectId: target.projectId, spaceId, hostNodeId: source.nodeId, draftId, revision,
    kind: "tracked_mask", source, binding, analysisInput, inputFingerprint, presentationRef: presented.presentationRef,
    ledgerReceipts: { source: presented.receipt }, versionIds: { source: presented.versionId } });
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result,created_at)
    VALUES (${taskId},${target.userId},${target.projectId},${spaceId},'mini_tool_analysis','append','mini_tool','pending',
      ${pg.json({ analysis, requestFingerprint: randomBytes(32).toString("hex"), sourceKey, credits: 0 })},${pg.json({ analysis: record })},${ACCEPTED_AT}::text::timestamptz)`;
  // The analysis pin the analysis admission writes; the clips and RLEs are appended to it (§10.3).
  const toolInputId = presented.presentationRef.source.toolInputId;
  await presentationPinService.acquire({ holderKind: "analysis", holderId: taskId, toolInputId, objectKeys: presentationPinService.ledgerObjectKeys(sourceKey, toolInputId) });
  return { ...target, taskId };
}

/**
 * Run the executor pickup by pickup until it returns or throws something other than a wait.
 * @param f - The fixture.
 * @returns The result.
 * @throws {Error} When the executor fails or never ends.
 */
async function drive(f: Fixture): Promise<Record<string, unknown>> {
  const execution = await miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, f.taskId);
  const run = await executor();
  for (let pickup = 0; pickup < 30; pickup += 1) {
    try { return await run(execution, Date.now() + 3_600_000); } catch (error) { if (!(error instanceof StillRunning)) throw error; }
  }
  throw new Error("The tracked mask analysis never ended");
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

describe("the tracked mask analysis executor (execution design §10.2, §10.3)", () => {
  it("TA01 prepares both clips, tracks each from its frame 0 and registers the joined RLE as the one artifact", async () => {
    const f = await seed();
    const result = await drive(f);
    const prepares = submitted.filter((job) => job.outputs[0]!.recipe.kind === "prepare_model_input");
    const forward = prepares.find((job) => job.outputs[0]!.recipe.order === "forward");
    const reverse = prepares.find((job) => job.outputs[0]!.recipe.order === "reverse");
    expect(forward?.outputs[0]!.recipe.window).toEqual({ start: 300, end: 600 });
    expect(reverse?.outputs[0]!.recipe.window).toEqual({ start: 200, end: 301 });
    for (const job of [forward!, reverse!]) expect(job.containerClass).toBe("MiniToolContainerStd4");
    const tracks = outside.runPrediction.mock.calls.filter((call) => call[1] === TRACKER).map((call) => call[2] as Record<string, unknown>);
    expect(tracks.map((body) => body.video).sort()).toEqual([publicUrl(forward!.outputs[0]!.storageKey), publicUrl(reverse!.outputs[0]!.storageKey)].sort());
    for (const body of tracks) {
      // A model reads an object's type from its link's extension.
      expect(body.video).toMatch(/\.mp4$/);
      expect(body).toEqual({ video: body.video, prompt: "object", box_prompts: [{ frame_index: 0, object_id: 1, x_min: 288, y_min: 162, x_max: 480, y_max: 270 }], apply_mask: false });
    }
    const joins = submitted.filter((job) => job.outputs[0]!.recipe.kind === "rle_join");
    expect(joins).toHaveLength(1);
    const recipe = joins[0]!.outputs[0]!.recipe as { inputs: { inputId: string; order: string; frameCount: number }[]; width: number; height: number };
    expect(recipe.inputs.map((input) => [input.order, input.frameCount]).sort()).toEqual([["forward", 300], ["reverse", 101]]);
    expect([recipe.width, recipe.height]).toEqual([960, 540]);
    for (const input of recipe.inputs) expect(bound(joins[0]!, input.inputId)).toBeDefined();
    expect(joins[0]!.outputs[0]!.contentType).toBe("text/plain");
    const parsed = result as { kind: string; frameCount: number; sourceFrameMapping: unknown[]; artifactRefs: { role: string; assetId: string }[] };
    expect(parsed.kind).toBe("tracked_mask");
    expect(parsed.frameCount).toBe(400);
    expect(parsed.sourceFrameMapping).toHaveLength(400);
    expect(parsed.artifactRefs.map((ref) => ref.role)).toEqual(["rle"]);
    const [asset] = await pg<{ storage_key: string }[]>`SELECT storage_key FROM studio_assets WHERE id=${parsed.artifactRefs[0]!.assetId}`;
    expect(asset?.storage_key).toBe(joins[0]!.outputs[0]!.storageKey);
  });

  it("TA03 a reversed clip past the reverse buffer is reversed in chunks stitched latest first, and that stitch is tracked", async () => {
    // 40 frames of 960x540 at 8-bit 4:2:0 fit the buffer, so the 101-frame reversed clip [200, 301) takes three chunks.
    const settings = outside.config() as core.MiniToolsConfig;
    outside.config.mockImplementation(() => ({ ...settings, encoding: { ...settings.encoding, reverse_buffer_bytes: 960 * 540 * 1.5 * 40 } }));
    await drive(await seed());
    const reversed = submitted.filter((job) => job.outputs[0]!.recipe.kind === "prepare_model_input" && job.outputs[0]!.recipe.order === "reverse");
    expect(reversed.map((job) => job.outputs[0]!.recipe.window)).toEqual([{ start: 200, end: 240 }, { start: 240, end: 280 }, { start: 280, end: 301 }]);
    const stitches = submitted.filter((job) => job.outputs[0]!.recipe.kind === "stitch");
    expect(stitches).toHaveLength(1);
    const recipe = stitches[0]!.outputs[0]!.recipe as { chunks: { inputId: string }[]; audio: unknown };
    expect(recipe.audio).toBeNull();
    expect(recipe.chunks.map((chunk) => bound(stitches[0]!, chunk.inputId))).toEqual([...reversed].reverse().map((job) => job.outputs[0]!.storageKey));
    const tracks = outside.runPrediction.mock.calls.filter((call) => call[1] === TRACKER).map((call) => (call[2] as { video: string }).video);
    expect(tracks).toContain(publicUrl(stitches[0]!.outputs[0]!.storageKey));
  });

  it("TA02 a join with no foreground ends the analysis with empty_foreground at join", async () => {
    const f = await seed();
    scripted.set("rle_join", { schemaVersion: 2, state: "failed", reason: "empty_foreground", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } });
    const { TrackedMaskFailed } = (await import(/* @vite-ignore */ STEPS)) as { TrackedMaskFailed: new (failure: { code: string; step: string }) => Error };
    const failure = await drive(f).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TrackedMaskFailed);
    expect(failure).toMatchObject({ failure: { code: "empty_foreground", step: "join" } });
  });
});
