// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * S5: real admission/authorization/PG/Redis/holds/queue/settlement; only external presentation delivery is controlled.
 *
 * frames-split design §7.11, §5.4, §10.7: the request names its tool input per input id (`presentation_ref`) and its
 * outputs in grid frames; admission reads the selected version from the snapshot (its display grid, tool source and
 * keyframe statistics, no other object), recomputes the recipes, computes the exact §5.4 job layout, refuses a run whose
 * largest stage exceeds `encoding.max_parallel_chunks`, and quotes max(precheck, planned work). The frozen plan carries
 * presentationRef, the selected version, its versionId, the layout and the payer.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Queue } from "bullmq";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import * as shared from "@breatic/shared";
import * as miniTools from "@breatic/shared/mini-tools";
import { hashMiniToolValue, miniToolExecutionRecordSchema, planVideoFrames, planVideoSplit } from "@breatic/shared/mini-tools";
import { containerCostUsd, creditHoldService, creditsForUsd, MIN_TASK_CREDIT_COST, readMiniToolExecutionPlan } from "@breatic/domain";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { editKeyOf, presentedSource, REMOVAL_PLAN, type PresentedOptions } from "./presentation-fixtures.js";

type Tool = "video.extract-frames" | "video.split";
type Recipe = { kind: "frame"; frameIndex: number } | { kind: "segment"; range: { start: number; end: number } };
interface Output { outputIndex: number; nodeId: string; recipe: Recipe }
type Ref = { toolInputId: string; planSha256: string };
interface Body {
  tool: Tool; project_id: string; space_id: string; run_id: string;
  draft: { version: 1; draftId: string; revision: string; source: { nodeId: string; canonicalURL: string; mediaInfo: { width: number; height: number; duration: number; mimeType: string } }; inputs: []; params: Record<string, unknown> };
  analysis_refs: []; presentation_ref: { source: Ref }; outputs: Output[];
}
interface Fixture extends StudioFixture { body: Body; sourceId: string; sourceKey: string; hash: string; viewerId: string; otherId: string; bundle: shared.VideoPresentationVersion; versionId: string }
interface Plan extends Record<string, unknown> {
  taskId: string; binding: { assetId: string; contentHash: string; mediaInfo: { width: number; height: number; duration: number } };
  sourceKey: string; presentationRef: { source: Ref }; presentations: { source: shared.VideoPresentationVersion }; versionIds: { source: string };
  layout: { batches: number[][]; encodes: { outputIndex: number; chunks: { start: number; end: number }[] }[] };
  // §97 D12-1: the per-stage job counts of the frozen layout, frozen beside it.
  stageJobs?: { stage: string; jobs: number }[];
  outputs: Output[]; credits: number;
  targetNodeIds: string[]; requestFingerprint: string; planFingerprint: string;
  container: { containerClass: string; precheckSeconds: number; size: { vcpu: number; memory_gib: number; disk_gb: number }; prices: core.MiniToolsConfig["prices"]; limits: core.MiniToolsConfig["plan_limits"] };
}
interface Parent { id: string; user_id: string; status: string; params: { miniToolExecution: Plan }; result: Record<string, unknown>; billed_at: string | null; created_at: string; updated_at: string }

const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), reads: [] as string[], ingest: vi.fn(), config: vi.fn(),
  funded: null as ReadonlySet<string> | null }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof core>(), getMiniToolsConfig: outside.config }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));
// A02 swaps the platform-funded set in the entry admission imports; every other case reads the real set.
vi.mock("@breatic/shared/mini-tools", async (original) => {
  const actual = await original<typeof miniTools>();
  const real = actual as unknown as { PLATFORM_FUNDED: ReadonlySet<string>; miniToolChargeTo: (subject: string) => "platform" | "user" };
  return { ...actual,
    get PLATFORM_FUNDED(): ReadonlySet<string> { return outside.funded ?? real.PLATFORM_FUNDED; },
    miniToolChargeTo: (subject: string): "platform" | "user" => (outside.funded === null ? real.miniToolChargeTo(subject) : outside.funded.has(subject) ? "platform" : "user") };
});
// 44 grid frames at 10 fps over 4.4 s, read from the original with a keyframe every second (frames-split §4.1, §7.16).
const GRID_PLAN: shared.VideoPresentationPlan = { ...REMOVAL_PLAN, grid: { ...REMOVAL_PLAN.grid, fps: { numerator: 10, denominator: 1 } } };
const GRID_DISPLAY = { frameCount: 44, realFrameCount: 44 };
const KEYFRAMES: shared.SourceKeyframeStats = { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false };
let pg: ReturnType<typeof core.createPgClient>;
let queue: Queue;
let app: Hono;
let base: core.MiniToolsConfig;
let settings: core.MiniToolsConfig;
let publicUrl: (key: string) => string;
const tokens: string[] = [];

/** Configure a real paid admission without any provider key or external call. @throws {Error} On invalid deployment configuration. */
function configure(multiplier = 1): void {
  core.initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: String(multiplier), STRIPE_SECRET_KEY: "sk_test_unused_s5",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_s5", UPLOAD_BASE_URL: "https://assets.example.test" });
}

beforeAll(async () => {
  configure(); core.loadLocales(); core.initLogger("s5-admission-test");
  const actual = await vi.importActual<typeof core>("@breatic/core");
  base = structuredClone(actual.getMiniToolsConfig());
  pg = core.createPgClient(inject("DATABASE_URL"), { name: "s5-admission-fixtures", max: 8 });
  publicUrl = (await core.getStorageAdapter()).publicUrl.bind(await core.getStorageAdapter());
  queue = core.createQueue("tasks");
  app = (await import("@server/app.js")).createApp();
});
beforeEach(() => {
  configure();
  settings = Object.assign(structuredClone(base), { executions: { ...base.executions,
    "video.extract-frames": { container_class: "MiniToolContainerStd4", precheck_seconds: 17, max_outputs: 12, max_outputs_per_job: 8 },
    "video.split": { container_class: "MiniToolContainerStd4", precheck_seconds: 23, max_outputs: 12, max_outputs_per_job: 8 } } });
  outside.config.mockImplementation(() => settings);
  outside.snapshots.clear(); outside.reads.length = 0;
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    outside.reads.push(url);
    throw new Error(`Admission must not fetch any object: ${url}`);
  }));
});
afterAll(async () => {
  for (const token of tokens) await core.revokeSession(core.getRedis(), token);
  await pg.end(); core.initCore(process.env); vi.unstubAllGlobals();
});

/** Insert actual project roles rather than mocking authorization answers. @throws {Error} On fixture SQL failure. */
async function member(projectId: string, role: "viewer" | "editor"): Promise<string> {
  const id = randomUUID();
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${id},${`s5-${id}@example.test`},true)`;
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${projectId},${id},${role})`;
  return id;
}

/**
 * Declare the source's selected version as the snapshot answers it and point the request at that tool input.
 * @param f - The fixture.
 * @param options - What the version carries besides the 44-frame 10 fps grid on the original.
 * @returns Nothing.
 * @throws {z.ZodError} When the version is not valid.
 */
async function present(f: Fixture, options: PresentedOptions = {}): Promise<void> {
  const presented = await presentedSource(f.hash, f.sourceKey, publicUrl, { plan: GRID_PLAN, display: GRID_DISPLAY, duration: 4.4, keyframes: KEYFRAMES, ...options });
  Object.assign(f, { versionId: presented.versionId, bundle: presented.bundle });
  f.body.presentation_ref = presented.presentationRef;
  outside.snapshots.set(f.sourceKey, presented.snapshot);
}

/** Register measured video facts and fund the real target Studio, not the source Studio. @throws {Error} On fixture SQL failure. */
async function seed(tool: Tool = "video.split"): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "s5-t"); const source = await seedStudioFixture(pg, "s5-s");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
  await seedDesignatedLot(pg, target, 1000);
  const sourceId = randomUUID(); const sourceKey = `video/s5/${sourceId}.mp4`; const hash = randomBytes(32).toString("hex");
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceId},${source.studioId},${hash},${sourceKey},${publicUrl(sourceKey)},4096,'video/mp4','video','upload',${source.userId},960,540,4.4)`;
  const body: Body = { tool, project_id: target.projectId, space_id: randomUUID(), run_id: randomUUID(),
    draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: randomUUID(), canonicalURL: publicUrl(sourceKey),
      mediaInfo: { width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" } }, inputs: [],
    params: tool === "video.split" ? { cuts: [20, 40] } : { mode: "current", frameIndex: 23 } },
    analysis_refs: [], outputs: [], presentation_ref: { source: { toolInputId: "", planSha256: "" } } };
  const f = { ...target, body, sourceId, sourceKey, hash, viewerId: await member(target.projectId, "viewer"), otherId: await member(target.projectId, "editor") } as Fixture;
  await present(f);
  body.outputs = tool === "video.split"
    ? [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: 0, end: 20 } } },
      { outputIndex: 1, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: 20, end: 40 } } },
      { outputIndex: 2, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: 40, end: 44 } } }]
    // frames-split §10.6, §10.7: frame extraction plans one output, the current grid frame 23.
    : [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: "frame", frameIndex: 23 } }];
  return f;
}

/** Drive existing HTTP auth, idempotency, validation and planned startup. @throws {Error} On session storage or client failure. */
async function post(f: Fixture, body: unknown = f.body, key = randomUUID(), actor: string | null = f.userId): Promise<Response> {
  let cookie = "";
  if (actor !== null) {
    const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, actor);
    cookie = `${core.sessionCookieName()}=${token}`;
  }
  return app.request("/api/v1/mini-tools", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, Cookie: cookie }, body: JSON.stringify(body) });
}

/** Require a real success before later financial, permission or negative assertions. @throws {Error} On assertion failure. */
async function accept(f: Fixture, body: unknown = f.body, key = randomUUID()): Promise<void> {
  const response = await post(f, body, key);
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 201, body: { data: { task_id: (body as { run_id: string }).run_id, status: "pending" } } });
}

/** Read the full physical parent independently, preserving SQL instant precision. @throws {Error} On missing task or SQL failure. */
async function parent(id: string): Promise<Parent> {
  const [row] = await pg<Parent[]>`SELECT id,user_id,status,params,result,billed_at::text,created_at::text,updated_at::text FROM tasks WHERE id=${id}`;
  if (!row) throw new Error("Missing accepted S5 parent");
  return row;
}

/** Count only this run's original owners, not neighboring fixtures. @throws {Error} On SQL or queue failure. */
async function effects(id: string): Promise<{ tasks: number; rows: number; holds: number; jobs: number }> {
  const [count] = await pg<{ tasks: number; rows: number; holds: number }[]>`SELECT
    (SELECT count(*)::int FROM tasks WHERE id=${id}) AS tasks,
    (SELECT count(*)::int FROM node_tasks WHERE task_id=${id}) AS rows,
    (SELECT count(*)::int FROM credit_holds WHERE reference_id=${id}) AS holds`;
  if (!count) throw new Error("Missing count projection");
  return { ...count, jobs: await queue.getJob(id) ? 1 : 0 };
}

/** Prove matching input is accepted on independent destination nodes before testing a refusal. @throws {Error} On invalid control. */
async function control(f: Fixture): Promise<void> {
  const body = structuredClone(f.body); body.run_id = randomUUID();
  body.outputs.forEach((output) => { output.nodeId = randomUUID(); });
  await accept(f, body);
}

/** The same container floor/rounding path used by existing analysis admission. @throws {Error} On invalid price configuration. */
function estimate(tool: Tool, multiplier = 1): number {
  const operation = Reflect.get(settings.executions, tool) as { container_class: string; precheck_seconds: number };
  return Math.max(shared.ceilToCreditCent(creditsForUsd(containerCostUsd({ wallMs: operation.precheck_seconds * 1000, cpuUsec: null }, settings.classes[operation.container_class]!, settings.prices), multiplier)), MIN_TASK_CREDIT_COST);
}

/** Create a supplied failed outcome through SQL; S5 does not execute a worker. @throws {Error} On invalid record or fixture SQL. */
async function failedOriginal(f: Fixture): Promise<Parent> {
  await accept(f);
  const original = await parent(f.body.run_id); const plan = original.params.miniToolExecution;
  const record = miniToolExecutionRecordSchema.parse({ schemaVersion: 1, runId: f.body.run_id, status: "failed", planFingerprint: plan.planFingerprint,
    resultVersion: 1, sourceBindings: [plan.binding], outputs: plan.outputs.map((output) => ({ ...output, result: { status: "failed", error: { code: "output_failed" } } })),
    usage: [], billingState: "idle", error: { code: "output_failed" } });
  await pg`UPDATE tasks SET status='failed',result=${pg.json(z.json().parse({ ...original.result, miniToolExecution: record }))},completed_at=clock_timestamp() WHERE id=${f.body.run_id}`;
  await pg`UPDATE node_tasks SET status='failed',settled_at=clock_timestamp() WHERE task_id=${f.body.run_id}`;
  await creditHoldService.releaseHold(f.body.run_id);
  return parent(f.body.run_id);
}

/** A request in the shape the removed retry took, naming outputs of an earlier run. @throws {never} Never. */
function retry(f: Fixture, ids = [2], run = randomUUID()): { tool: Tool; project_id: string; space_id: string; run_id: string; retry: { runId: string; outputIndexes: number[] } } {
  return { tool: f.body.tool, project_id: f.projectId, space_id: f.body.space_id, run_id: run, retry: { runId: f.body.run_id, outputIndexes: ids } };
}

describe("S5 fresh frame and split execution admission", () => {
  it("S5-A00 proves the independent planner literals on the selected grid", async () => {
    const f = await seed();
    const grid = { fps: f.bundle.display.fps, frameCount: f.bundle.display.frameCount };
    expect(planVideoSplit(grid, f.body.draft.params.cuts as number[])).toEqual([
      { outputIndex: 0, start: 0, end: 20 }, { outputIndex: 1, start: 20, end: 40 }, { outputIndex: 2, start: 40, end: 44 },
    ]);
    expect(planVideoFrames(grid, { mode: "current", frameIndex: 23 })).toEqual([{ outputIndex: 0, frameIndex: 23 }]);
  });
  it.each(["video.extract-frames", "video.split"] as const)("S5-A01 freezes every %s output, measured source, selected version and Std4 policy before the real hold and queue", async (tool) => {
    const f = await seed(tool); const original = structuredClone(f.body);
    await accept(f);
    const stored = await parent(f.body.run_id); const plan = stored.params.miniToolExecution;
    // One batch holds every output under max_outputs_per_job; no output needs chunking (E3-6).
    expect(plan.layout).toEqual({ batches: [original.outputs.map((o) => o.outputIndex)], encodes: [] });
    expect(plan).toMatchObject({ tool, taskId: f.body.run_id, sourceKey: f.sourceKey,
      presentationRef: original.presentation_ref, presentations: { source: f.bundle }, versionIds: { source: f.versionId },
      binding: { assetId: f.sourceId, contentHash: f.hash, mediaInfo: { width: 960, height: 540, duration: 4.4 } },
      // §67.1 S5-A01/A05 (frames-split §5.5 「配置」行, §10.8 「计费」行): extract-frames is platform-funded, quoted 0 with no hold;
      // the payer is frozen in the plan for the worker and every retry.
      outputs: original.outputs, targetNodeIds: original.outputs.map((o) => o.nodeId), credits: tool === "video.split" ? estimate(tool) : 0,
      chargeTo: tool === "video.split" ? "user" : "platform",
      container: { containerClass: "MiniToolContainerStd4", precheckSeconds: tool === "video.split" ? 23 : 17,
        size: settings.classes.MiniToolContainerStd4, prices: settings.prices, limits: settings.plan_limits } });
    // §93 D5-2 (design D-2 「crf/preset 取冻结的受理 limits」, §5.4 「编码参数完全一致」): the run's encode parameters and retry cap are
    // frozen with its container.
    expect(plan.container).toMatchObject({ encode: { crf: settings.presentation.crf, preset: settings.presentation.preset }, chunkRetries: settings.encoding.chunk_retries });
    const { requestFingerprint, planFingerprint, ...projection } = plan;
    expect(requestFingerprint).toBe(await hashMiniToolValue(original)); expect(planFingerprint).toBe(await hashMiniToolValue(projection));
    const rows = await pg`SELECT node_id,budget_ms,action FROM node_tasks WHERE task_id=${f.body.run_id} ORDER BY node_id`;
    expect([...rows]).toEqual(original.outputs.map((o) => ({ node_id: o.nodeId, budget_ms: 7200000, action: "mini_tool" })).sort((a, b) => a.node_id.localeCompare(b.node_id)));
    const holds = await pg`SELECT studio_id,amount::float8,status FROM credit_holds WHERE reference_id=${f.body.run_id}`;
    expect([...holds]).toEqual(tool === "video.split" ? [{ studio_id: f.studioId, amount: estimate(tool), status: "held" }] : []);
    expect(await effects(f.body.run_id)).toEqual({ tasks: 1, rows: original.outputs.length, holds: tool === "video.split" ? 1 : 0, jobs: 1 });
    expect(await queue.getJob(f.body.run_id)).toMatchObject({ id: f.body.run_id, name: "execute-mini-tool", data: { taskId: f.body.run_id, executionKind: "planned" } });
    // The selected version carries the grid, tool source and keyframe statistics: admission fetches no object (§7.11).
    expect(outside.reads).toEqual([]);
  });
  // §97 D11-1: a frame plan has one output, so its order row moved to the segment plan below (4.4.5).
  it.each(["frameIndex", "omission", "addition"])("S5-A02 refuses a frame plan %s before any durable execution side effect", async (bad) => {
    const f = await seed("video.extract-frames"); await control(f);
    if (bad === "frameIndex") Object.assign(f.body.outputs[0]!.recipe, { frameIndex: 1 });
    else if (bad === "omission") f.body.outputs.pop();
    else f.body.outputs.push({ outputIndex: 1, nodeId: randomUUID(), recipe: { kind: "frame", frameIndex: 41 } });
    expect((await post(f)).status).toBe(422); expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
  it.each(["start", "end", "omission", "addition", "order"])("S5-A02 refuses a segment plan %s after a valid control", async (bad) => {
    const f = await seed(); await control(f);
    if (bad === "start") Object.assign(f.body.outputs[0]!.recipe, { range: { start: 1, end: 20 } });
    else if (bad === "end") Object.assign(f.body.outputs[1]!.recipe, { range: { start: 20, end: 41 } });
    else if (bad === "omission") f.body.outputs.pop();
    else if (bad === "addition") f.body.outputs.push({ outputIndex: 3, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: 40, end: 44 } } });
    else f.body.outputs.reverse();
    expect((await post(f)).status).toBe(422); expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
  it.each(["source deleted", "source hash", "ref toolInputId", "ref planSha256", "selected version moved", "nothing selected"])("S5-A03 refuses a request whose tool input is not the selected one: %s", async (bad) => {
    const f = await seed(); await control(f);
    const snapshot = structuredClone(outside.snapshots.get(f.sourceKey)) as { presentation: Record<string, unknown> | null };
    if (bad === "source deleted") await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.sourceId}`;
    else if (bad === "source hash") await pg`UPDATE studio_assets SET content_hash=${"e".repeat(64)} WHERE id=${f.sourceId}`;
    else if (bad === "ref toolInputId") f.body.presentation_ref.source.toolInputId = "b".repeat(64);
    else if (bad === "ref planSha256") f.body.presentation_ref.source.planSha256 = "b".repeat(64);
    else if (bad === "selected version moved") snapshot.presentation = { ...snapshot.presentation, toolInputId: "b".repeat(64) };
    else snapshot.presentation = null;
    outside.snapshots.set(f.sourceKey, snapshot);
    expect((await post(f)).status).toBe(422); expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
  it.each([1, 2.5])("S5-A05 holds the configured Std4 estimate once with multiplier %s and leaves every deadline at two hours", async (multiplier) => {
    const f = await seed(); configure(multiplier);
    const operation = Reflect.get(settings.executions, "video.split") as { precheck_seconds: number }; operation.precheck_seconds = 137;
    settings.prices.vcpu_second_usd *= 3; settings.plan_limits.analysisStdoutBytes = 8192;
    await accept(f); const plan = (await parent(f.body.run_id)).params.miniToolExecution;
    expect(plan.credits).toBe(estimate("video.split", multiplier));
    expect(plan.container).toMatchObject({ precheckSeconds: 137, size: { vcpu: 4, memory_gib: 12 }, prices: settings.prices, limits: settings.plan_limits });
    const held = await pg`SELECT amount::float8,status FROM credit_holds WHERE reference_id=${f.body.run_id}`;
    expect([...held]).toEqual([{ amount: estimate("video.split", multiplier), status: "held" }]);
    expect([...(await pg`SELECT DISTINCT budget_ms FROM node_tasks WHERE task_id=${f.body.run_id}`)]).toEqual([{ budget_ms: 7200000 }]);
  });
  // §97 D11-1 (4.4.5): every frame mode plans one output, so the output-limit refusal keeps its meaning on the segment plan only.
  it.each(["video.split"] as const)("S5-A05 enforces the configured %s output limit without claiming measured production capacity", async (tool) => {
    const f = await seed(tool); const operation = Reflect.get(settings.executions, tool) as { max_outputs: number };
    operation.max_outputs = f.body.outputs.length;
    await control(f); operation.max_outputs -= 1;
    expect((await post(f)).status).toBe(422); expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
  it("S5-A06 replays the original complete immutable plan before consulting changed source, presentation, draft or pricing", async () => {
    const f = await seed(); const original = structuredClone(f.body); const key = randomUUID(); await accept(f, original, key);
    const before = await parent(f.body.run_id); outside.ingest.mockClear(); outside.reads.length = 0;
    await pg`UPDATE studio_assets SET content_hash=${"e".repeat(64)},duration_seconds=99 WHERE id=${f.sourceId}`;
    settings.prices.vcpu_second_usd *= 9; settings.encoding.encoder.start_seconds = 999;
    f.body.draft.params.cuts = []; f.body.draft.revision = randomUUID();
    await accept(f, original, key); await accept(f, original);
    expect(await parent(original.run_id)).toEqual(before); expect(outside.ingest).not.toHaveBeenCalled(); expect(outside.reads).toEqual([]);
    expect((await readMiniToolExecutionPlan(original.run_id)).execution).toEqual(before.params.miniToolExecution);
    expect((await post(f)).status).toBe(409); expect(await parent(original.run_id)).toEqual(before);
    expect(await effects(original.run_id)).toEqual({ tasks: 1, rows: 3, holds: 1, jobs: 1 });
  });
  it("S5-A06 rejects same-key changed body without disturbing the original money or queue", async () => {
    const f = await seed(); const key = randomUUID(); await accept(f, f.body, key); const before = await parent(f.body.run_id);
    const changed = structuredClone(f.body); changed.draft.revision = randomUUID();
    expect((await post(f, changed, key)).status).toBe(422); expect(await parent(f.body.run_id)).toEqual(before);
    expect(await effects(f.body.run_id)).toEqual({ tasks: 1, rows: 3, holds: 1, jobs: 1 });
  });
  it("S5-A07 observes two real claim INSERT contenders and only one full-output hold/job", async () => {
    const f = await seed(); await control(f);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const ready = new Promise<void>((resolve) => { entered = resolve; });
    const owner = pg.begin(async (tx) => { await tx`LOCK TABLE tasks IN SHARE MODE`; entered(); await gate; }); await ready;
    const first = post(f); const second = post(f); void first.catch(() => undefined); void second.catch(() => undefined);
    try { await waitUntilBlockedOn(pg, ["insert into", "tasks"], 2); release(); await owner;
      expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([201, 201]);
      expect(await effects(f.body.run_id)).toEqual({ tasks: 1, rows: 3, holds: 1, jobs: 1 });
    } finally { release(); await owner; await Promise.allSettled([first, second]); }
  });
  it.each(["viewer", "removed", "outsider", "unauthenticated"])("S5-A08 enforces current %s authority with no admission side effects", async (bad) => {
    const f = await seed(); await control(f); let actor: string | null = f.userId;
    if (bad === "viewer") actor = f.viewerId;
    else if (bad === "removed") await pg`UPDATE project_members SET deleted_at=clock_timestamp() WHERE project_id=${f.projectId} AND user_id=${f.userId}`;
    else if (bad === "outsider") actor = (await seedStudioFixture(pg, "s5-out")).userId;
    else actor = null;
    expect((await post(f, f.body, randomUUID(), actor)).status).toBe(bad === "viewer" ? 403 : bad === "unauthenticated" ? 401 : 404);
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
});

// frames-split §7.19: a run is rerun only as a whole, from the tool's panel; no request names failed outputs of an
// earlier run to retry.
describe("S5 no per-output retry admission (frames-split §7.19)", () => {
  it("S5-R01 a request that names outputs of an earlier run to retry is refused and admits nothing", async () => {
    const f = await seed(); const before = await failedOriginal(f); const body = retry(f);
    expect((await post(f, body)).status).toBe(422);
    expect(await effects(body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
    expect(await parent(f.body.run_id)).toEqual(before);
  });
});

/** Credits for some standard-4 seconds at the current settings: the one container quote rule (E3-5). @throws {Error} On invalid prices. */
function std4Credits(seconds: number, multiplier = 1): number {
  return Math.max(shared.ceilToCreditCent(creditsForUsd(containerCostUsd({ wallMs: seconds * 1000, cpuUsec: null }, settings.classes.MiniToolContainerStd4!, settings.prices), multiplier)), MIN_TASK_CREDIT_COST);
}

describe("E3 job layout, parallel cap and quote at admission (inner#1306 §90 E3-3 to E3-6; design §5.4, §7.11)", () => {
  it("E3-A01 a run whose standard-4 job count exceeds the parallel cap is refused with its reason and no durable effect", async () => {
    const f = await seed(); await control(f);
    settings.encoding.max_parallel_chunks = 1;
    (Reflect.get(settings.executions, "video.split") as { max_outputs_per_job: number }).max_outputs_per_job = 1;
    const response = await post(f);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(shared.t("server.mini_tool.runTooLong", { max: 1 }));
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });

  // Frames-split design §10.7 产物上限: more outputs than the tool's max_outputs are refused with the limit named.
  it("E3-A08 a split with more outputs than max_outputs is refused naming the limit, with no durable effect", async () => {
    const f = await seed(); await control(f);
    (Reflect.get(settings.executions, "video.split") as { max_outputs: number }).max_outputs = 2;
    const response = await post(f);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(shared.t("server.mini_tool.tooManyOutputs", { max: 2 }));
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });

  it("E3-A02 the same three outputs in one batch fit a cap of one job", async () => {
    const f = await seed();
    settings.encoding.max_parallel_chunks = 1;
    await accept(f);
    expect((await parent(f.body.run_id)).params.miniToolExecution.layout).toEqual({ batches: [[0, 1, 2]], encodes: [] });
  });

  it("E3-A03 batches follow max_outputs_per_job in stable output order", async () => {
    const f = await seed();
    (Reflect.get(settings.executions, "video.split") as { max_outputs_per_job: number }).max_outputs_per_job = 2;
    await accept(f);
    expect((await parent(f.body.run_id)).params.miniToolExecution.layout).toEqual({ batches: [[0, 1], [2]], encodes: [] });
  });

  it("E3-A04 the quote is the precheck floor when the planned work is smaller", async () => {
    const f = await seed();
    (Reflect.get(settings.executions, "video.split") as { precheck_seconds: number }).precheck_seconds = 10000;
    await accept(f);
    expect((await parent(f.body.run_id)).params.miniToolExecution.credits).toBe(std4Credits(10000));
  });

  it("E3-A05 the quote covers the planned work when it exceeds the precheck: at least every job's start seconds", async () => {
    const f = await seed();
    (Reflect.get(settings.executions, "video.split") as { precheck_seconds: number }).precheck_seconds = 1;
    // A price at which one second is the 5-credit minimum and three seconds about 12 credits, well inside the seeded lot.
    settings.prices.vcpu_second_usd = 0.01;
    await accept(f);
    const credits = (await parent(f.body.run_id)).params.miniToolExecution.credits;
    expect(credits).toBeGreaterThan(std4Credits(1));
    expect(credits).toBeGreaterThanOrEqual(std4Credits(settings.encoding.encoder.start_seconds));
    const [hold] = await pg`SELECT amount::float8 FROM credit_holds WHERE reference_id=${f.body.run_id}`;
    expect(hold).toEqual({ amount: credits });
  });

  it("E3-A07 a target-policy preparation in progress does not block admission", async () => {
    const f = await seed();
    const snapshot = outside.snapshots.get(f.sourceKey) as { preparation: unknown };
    snapshot.preparation = { targetPolicyVersion: 2, jobId: "video-presentation:next", stage: "encode", failure: null };
    await accept(f);
  });
});

// §97 D12-1 (frames-split §5.4 上限 and 预算 rows): the cap is the number of container jobs one stage sends at once, so
// admission compares the largest stage of the frozen layout with `encoding.max_parallel_chunks`, not the total, and freezes
// the stage counts as `stageJobs` beside `layout`. For split, encode is every batch plus every chunk, stitch one per chunked
// output. The configuration below makes each 2 s segment (20 frames plus the original's 11-frame pre-roll) exceed one job's
// 20 s share and chunk, while the 0.4 s segment (4 frames) stays in a batch: work is one second per frame and decode is
// negligible.
describe("stage job counts at admission (§97 D12-1; frames-split §5.4)", () => {
  /** Configure chunked split outputs at a given cap. @throws {Error} When the task configuration cannot be read. */
  function chunked(cap = 8): void {
    const encoder = settings.encoding.encoder;
    encoder.start_seconds = 1;
    encoder.encode_pixels_per_second = 960 * 540;
    for (const key of Object.keys(encoder.decode_convert_pixels_per_second) as (keyof typeof encoder.decode_convert_pixels_per_second)[]) {
      encoder.decode_convert_pixels_per_second[key] = 1e15;
    }
    settings.encoding.chunk_share = 20 / (core.getNodeTaskConfig().default_budget_ms / 1000);
    settings.encoding.max_parallel_chunks = cap;
  }
  /** The stages counted from a frozen split layout. @throws {never} Never. */
  const stagesOf = (layout: Plan["layout"]): { stage: string; jobs: number }[] => [
    { stage: "encode", jobs: layout.batches.length + layout.encodes.reduce((total, encode) => total + encode.chunks.length, 0) },
    ...(layout.encodes.length > 0 ? [{ stage: "stitch", jobs: layout.encodes.length }] : []),
  ];
  /** Admit one chunked split under the default cap and return its frozen plan. @throws {Error} On admission failure. */
  async function chunkedPlan(): Promise<Plan> {
    const f = await seed(); chunked();
    await accept(f);
    const plan = (await parent(f.body.run_id)).params.miniToolExecution;
    expect(plan.layout.encodes.length).toBeGreaterThan(0);
    return plan;
  }

  it("SA01 freezes the stage counts of the frozen layout beside it", async () => {
    const plan = await chunkedPlan();
    expect(plan.stageJobs).toEqual(stagesOf(plan.layout));
  });

  // frames-split §5.4 chunking row: each chunk holds as many frames as fit the share beside its own pre-roll, counted once:
  // (20 s share − 1 s start) − 11 pre-roll frames at 1 s leaves 8 frames, so each 20-frame segment takes 3 chunks.
  it("SA04 sizes each chunk by the frames that fit the share beside one pre-roll", async () => {
    const plan = await chunkedPlan();
    expect(plan.layout.encodes.map((encode) => encode.chunks)).toEqual([
      { outputIndex: 0, base: 0 }, { outputIndex: 1, base: 20 },
    ].map(({ base }) => [{ start: base, end: base + 6 }, { start: base + 6, end: base + 13 }, { start: base + 13, end: base + 20 }]));
  });

  it("SA02 admits a split whose total jobs exceed the cap while its largest stage does not", async () => {
    const stages = stagesOf((await chunkedPlan()).layout);
    const largest = Math.max(...stages.map((stage) => stage.jobs));
    expect(stages.reduce((total, stage) => total + stage.jobs, 0)).toBeGreaterThan(largest);
    const f = await seed(); chunked(largest);
    await accept(f);
    expect((await parent(f.body.run_id)).params.miniToolExecution.stageJobs).toEqual(stages);
  });

  it("SA03 refuses a split whose largest stage exceeds the cap with runTooLong and no durable effect", async () => {
    const largest = Math.max(...stagesOf((await chunkedPlan()).layout).map((stage) => stage.jobs));
    const f = await seed(); chunked(largest - 1);
    const response = await post(f);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(shared.t("server.mini_tool.runTooLong", { max: largest - 1 }));
    expect(await effects(f.body.run_id)).toEqual({ tasks: 0, rows: 0, holds: 0, jobs: 0 });
  });
});

// frames-split §5.4 estimate row, §7.16: every job reading the original pays the decode pre-roll of its keyframe statistics,
// max(largest keyframe interval, 3/23 s) × fps + 1 frames; a job reading the all-intra edit file pays none. The quote's
// planned work per output (`outputSeconds`) carries it.
describe("the decode pre-roll from the tool source (frames-split §5.4 estimate row, §7.16)", () => {
  /** The planned work of one span on the 960x540 grid: the shared estimate minus the start seconds, as admission freezes it. */
  const planned = (frames: number, preroll: number, decodeKey: miniTools.VideoDecodeKey): number => {
    const { encoder, decoder } = settings.encoding;
    const rates = { startSeconds: encoder.start_seconds, encodePixelsPerSecond: encoder.encode_pixels_per_second, tonemapPixelsPerSecond: encoder.tonemap_pixels_per_second,
      decodeConvertPixelsPerSecond: { ...encoder.decode_convert_pixels_per_second, edit_h264_intra_8bit_420: decoder.edit_h264_intra_8bit_420_pixels_per_second },
      editEncodePixelsPerSecond: {} } as unknown as miniTools.VideoEncoderRates;
    return miniTools.estimateVideoJobSeconds({ encodedFrames: frames, prerollFrames: preroll, sourceWidth: 960, sourceHeight: 540, outputWidth: 960, outputHeight: 540,
      decodeKey, encodeKey: "playback", toneMap: false }, rates) - rates.startSeconds;
  };

  it.each([
    // A keyframe every second at 10 fps: ceil(1 × 10 + 1) = 11 frames.
    ["a keyframe every second", 1, 11],
    // Keyframes closer than FFmpeg's 3/23 s move: ceil(3/23 × 10 + 1) = 3 frames.
    ["dense keyframes", 0.05, 3],
    // A keyframe every 2.5 s: ceil(2.5 × 10 + 1) = 26 frames.
    ["sparse keyframes", 2.5, 26],
  ] as const)("PR01 each span reading the original pays the pre-roll of %s", async (_name, interval, preroll) => {
    const f = await seed();
    await present(f, { keyframes: { ...KEYFRAMES, maxKeyframeInterval: interval } });
    await accept(f);
    const plan = (await parent(f.body.run_id)).params.miniToolExecution as Plan & { outputSeconds: number[] };
    [20, 20, 4].forEach((frames, index) => expect(plan.outputSeconds[index]).toBeCloseTo(planned(frames, preroll, "sdr_8bit"), 9));
  });

  it("PR02 a span reading the edit file pays no pre-roll and decodes at its tier's rate", async () => {
    const f = await seed();
    await present(f, { edit: true });
    await accept(f);
    const plan = (await parent(f.body.run_id)).params.miniToolExecution as Plan & { outputSeconds: number[] };
    [20, 20, 4].forEach((frames, index) => expect(plan.outputSeconds[index]).toBeCloseTo(planned(frames, 0, "edit_h264_intra_8bit_420"), 9));
  });
});

describe("E4 execution pins at admission (inner#1306 §90 E4-4, E4-5; design §7.15 execution 行, 可重试结束)", () => {
  /**
   * The live pins of a holder, with their keys.
   * @param holderId - The holder.
   * @returns Rows.
   */
  async function livePins(holderId: string): Promise<{ holder_kind: string; tool_input_id: string; keys: string[] }[]> {
    return pg`SELECT p.holder_kind,p.tool_input_id,
        coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL), '{}') AS keys
      FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
      WHERE p.holder_id=${holderId} AND p.deleted_at IS NULL GROUP BY p.id ORDER BY p.holder_kind`;
  }

  it("E4-P01 a fresh admission pins its tool input for the run, in the admission: no object on the original, the edit file on an edit source", async () => {
    const f = await seed(); await accept(f);
    expect(await livePins(f.body.run_id)).toEqual([{ holder_kind: "execution", tool_input_id: f.body.presentation_ref.source.toolInputId, keys: [] }]);
    const e = await seed(); await present(e, { edit: true }); await accept(e);
    expect(await livePins(e.body.run_id)).toEqual([{ holder_kind: "execution", tool_input_id: e.body.presentation_ref.source.toolInputId, keys: [editKeyOf(e.sourceKey)] }]);
  });

  it("E4-P02 a refused admission pins nothing", async () => {
    const f = await seed(); await control(f);
    settings.encoding.max_parallel_chunks = 1;
    (Reflect.get(settings.executions, "video.split") as { max_outputs_per_job: number }).max_outputs_per_job = 1;
    expect((await post(f)).ok).toBe(false);
    expect(await livePins(f.body.run_id)).toEqual([]);
  });
});

/**
 * Ask the quote endpoint for a fresh request.
 * @param f - The fixture.
 * @param body - The request.
 * @returns The answer.
 * @throws {Error} On session storage or client failure.
 */
async function quote(f: Fixture, body: unknown = f.body): Promise<{ status: number; body: unknown }> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await core.setSession(core.getRedis(), token, f.userId);
  const response = await app.request("/api/v1/mini-tools/quote", { method: "POST", headers: { "Content-Type": "application/json", Cookie: `${core.sessionCookieName()}=${token}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

// inner#1306 test plan §67.1 (S5-A01, S5-A05, S5-R05 rewritten) and §67.2 (A01, A02); frames-split design §5.5 「配置」行,
// §10.7, §10.8 「请求」「受理」「计费」「重试」行. The shared platform-funded set (`packages/shared/src/mini-tools/platform-funded.ts`)
// names `video.extract-frames` and `video.focus-crop` (`PLATFORM_FUNDED`, `miniToolChargeTo`);
// A02 replaces both in the `@breatic/shared/mini-tools` entry admission imports.
describe("frame-grid requests and the platform-funded set at admission (§67.1, §67.2)", () => {
  it.each([
    ["first", 0], ["last", 43], ["current", 30],
  ] as const)("S5-A01 a %s frame is planned on the selected grid by frame number alone; the measured grid beats the client's media info", async (mode, frameIndex) => {
    const f = await seed("video.extract-frames");
    // The request names grid frame numbers only (§10.8 请求行: `{ kind: 'frame', frameIndex }`, no seconds); the draft keeps the
    // player's grid frame in every mode, as the panel sends it.
    f.body.draft.params = { mode, frameIndex: 30 };
    f.body.outputs = [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: "frame", frameIndex } as unknown as Recipe }];
    await accept(f);
    expect((await parent(f.body.run_id)).params.miniToolExecution.outputs).toEqual(f.body.outputs);
  });

  it("S5-A01 split cuts in grid frame numbers, out of order, repeated and on both ends, plan N+1 segments [k0,k1) to frameCount, each kept with its node", async () => {
    const f = await seed("video.split");
    f.body.draft.params = { cuts: [40, 20, 44, 0, 20] };
    f.body.outputs = [{ start: 0, end: 20 }, { start: 20, end: 40 }, { start: 40, end: 44 }]
      .map((range, outputIndex) => ({ outputIndex, nodeId: randomUUID(), recipe: { kind: "segment", range } }));
    await accept(f);
    const plan = (await parent(f.body.run_id)).params.miniToolExecution;
    expect(plan.outputs).toEqual(f.body.outputs);
    expect(plan.targetNodeIds).toEqual(f.body.outputs.map((output) => output.nodeId));
  });

  it("S5-A05 / A01 extract-frames is quoted 0, holds nothing and freezes chargeTo platform; its node rows keep the two-hour budget", async () => {
    const f = await seed("video.extract-frames");
    expect(await quote(f)).toEqual({ status: 200, body: { data: { credits: 0 } } });
    await accept(f);
    const plan = (await parent(f.body.run_id)).params.miniToolExecution;
    expect({ credits: plan.credits, chargeTo: plan.chargeTo }).toEqual({ credits: 0, chargeTo: "platform" });
    expect(await effects(f.body.run_id)).toEqual({ tasks: 1, rows: 1, holds: 0, jobs: 1 });
    expect([...(await pg`SELECT DISTINCT budget_ms FROM node_tasks WHERE task_id=${f.body.run_id}`)]).toEqual([{ budget_ms: 7200000 }]);
  });

  it("A01 split stays user-paid: chargeTo user is frozen and the real hold equals the container quote", async () => {
    const f = await seed("video.split");
    await accept(f);
    const plan = (await parent(f.body.run_id)).params.miniToolExecution;
    expect({ credits: plan.credits, chargeTo: plan.chargeTo, containerClass: plan.container.containerClass }).toEqual({ credits: estimate("video.split"), chargeTo: "user", containerClass: "MiniToolContainerStd4" });
    expect([...(await pg`SELECT amount::float8,status FROM credit_holds WHERE reference_id=${f.body.run_id}`)]).toEqual([{ amount: estimate("video.split"), status: "held" }]);
  });

  it("A02 changing the platform-funded set after admission leaves the admitted run's frozen plan as it was", async () => {
    const f = await seed("video.extract-frames"); await accept(f);
    const before = await parent(f.body.run_id);
    outside.funded = new Set(["video.focus-crop"]);
    try {
      expect((await parent(f.body.run_id)).params).toEqual(before.params);
      expect(before.params.miniToolExecution.chargeTo).toBe("platform");
      // A fresh run after the change is user-paid: the set decides admission, the frozen value decides everything after it.
      const fresh = await seed("video.extract-frames"); await accept(fresh);
      expect((await parent(fresh.body.run_id)).params.miniToolExecution.chargeTo).toBe("user");
    } finally { outside.funded = null; }
  });
});
