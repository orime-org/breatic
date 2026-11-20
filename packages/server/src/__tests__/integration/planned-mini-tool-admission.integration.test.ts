// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real HTTP middleware, PG roles/assets/tasks/rows/credit holds and BullMQ. No supplier or media is invoked.
 *
 * S6e E3b (inner#1306 test plan §90): the split request names its tool input; the ingest presentation read and the
 * full/compact objects are controlled at the shared client and `fetch`. The quote is the standard-4 run at its 300 s
 * floor (the 5-credit minimum at multiplier 1; 6.69 at multiplier 2).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { Queue, type Job, type JobsOptions } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import {
  createPgClient, createQueue, getNodeTaskConfig, getRedis, getStorageAdapter, initCore, initLogger,
  loadLocales, logger, revokeSession, sessionCookieName, setSession,
} from "@breatic/core";
import type * as shared from "@breatic/shared";
import { NO_CONSENT } from "@breatic/shared";
import { miniToolPlanJobRequestSchema } from "@breatic/shared";
import { miniToolConsumptionKey, type MiniToolConsumptionIdentity, type MiniToolPlannedRequest } from "@breatic/shared/mini-tools";
import {
  creditHoldService, miniToolExecutionService, modelCatalog, openMiniToolPlanJob, upstreamStepRepo, type AcceptedMiniToolExecution, initProvider,
} from "@breatic/domain";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { executionSnapshot, seedExecution, type ExecutionFixture } from "../../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";
import { presentedSource } from "./presentation-fixtures.js";

const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));

const BODY: Extract<MiniToolPlannedRequest, { tool: "video.split" }> = {
  tool: "video.split",
  project_id: "10000000-0000-4000-8000-000000000001",
  space_id: "20000000-0000-4000-8000-000000000001",
  run_id: "50000000-0000-4000-8000-000000000001",
  draft: {
    version: 1,
    draftId: "60000000-0000-4000-8000-000000000001",
    revision: "70000000-0000-4000-8000-000000000001",
    source: {
      nodeId: "30000000-0000-4000-8000-000000000001",
      canonicalURL: "https://assets.example.test/video/source.mp4",
      mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" },
    },
    inputs: [],
    params: { cuts: [] },
  },
  analysis_refs: [],
  // The whole grid of the fixture's selected version (presentation-fixtures.ts: 1011 frames at 200 fps).
  outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "segment", range: { start: 0, end: 1011 } } }],
  // Each seed replaces this with its source's selected tool input (E3b).
  presentation_ref: { source: { toolInputId: "0".repeat(64), planSha256: "0".repeat(64) } },
};

interface Fixture extends StudioFixture { body: Extract<MiniToolPlannedRequest, { tool: "video.split" }>; viewerId: string; otherId: string; sourceId: string; sourceStudioId: string; sourceKey: string; sourceHash: string }
interface TaskRow { status: string; params: { miniToolExecution: AcceptedMiniToolExecution }; result: Record<string, unknown> | null; error_message: string | null; billed_at: string | null }
let pg: ReturnType<typeof createPgClient>;
let queue: Queue;
let app: Hono;
let publicUrl: (key: string) => string;
const tokens: string[] = [];
const add = Queue.prototype.add;
const ACK_ERROR = new Error("fixture queue acknowledgement unavailable");
const OUTPUT_HASH = "147d7b46f5062b1cc7231edff71bed11071dd088c5b3434432f24e5d41037a07";

/** Apply only dummy external keys and actual catalog/payment configuration.
 * @throws {Error} When injected test configuration is invalid.
 */
function configure(payment = true, multiplier = 1, key = "unused-planned-admission"): void {
  initCore({ ...process.env, PAYMENT_ENABLED: String(payment), CREDIT_MULTIPLIER: String(multiplier), WAVESPEED_API_KEY: key,
    STRIPE_SECRET_KEY: "sk_test_unused", STRIPE_WEBHOOK_SECRET: "whsec_unused", UPLOAD_BASE_URL: "https://assets.example.test" });
  // The provider reads the keys just set: a missing WaveSpeed key makes its models unservable here.
  initProvider();
  modelCatalog.resetModelCatalog();
}
beforeAll(async () => {
  configure(); loadLocales(); initLogger("planned-admission-fixture"); pg = createPgClient(inject("DATABASE_URL"), { name: "planned-post-fixtures", max: 8 });
  const storage = await getStorageAdapter(); publicUrl = storage.publicUrl.bind(storage); queue = createQueue("tasks");
  const { createApp } = await import("@server/app.js"); app = createApp();
});
beforeEach(() => {
  configure();
  outside.ingest.mockReset().mockImplementation(async (_url: string, _secret: string, input: { action: string; storageKey: string }): Promise<unknown> => {
    if (input.action !== "read") throw new Error(`Unexpected presentation admission ${input.action}`);
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = outside.bodies.get(url);
    if (body === undefined) throw new Error(`Admission fetched an unstored URL: ${url}`);
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => { for (const token of tokens) await revokeSession(getRedis(), token); await pg.end(); initCore(process.env); initProvider(); modelCatalog.resetModelCatalog(); vi.unstubAllGlobals(); });

/** A real, currently authorized member; UUIDs do not stand in for role decisions.
 * @throws {Error} On a fixture SQL failure.
 */
async function member(projectId: string, role: "editor" | "viewer"): Promise<string> {
  const id = randomUUID(); await pg`INSERT INTO users (id,email,email_verified) VALUES (${id},${`post-${id}@example.test`},true)`;
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${projectId},${id},${role})`; return id;
}
/** Seed a real target and a separately owned registered source with the independent 5.055 quote input.
 * @throws {Error} On fixture or credit-owner failure.
 */
async function seed(credits = 1000): Promise<Fixture> {
  const target = await seedStudioFixture(pg, "post-t"); const source = await seedStudioFixture(pg, "post-s");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${target.projectId},${target.userId},'editor')`;
  if (credits > 0) await seedDesignatedLot(pg, target, credits);
  const sourceId = randomUUID(); const sourceKey = `video/post-source/${sourceId}.mp4`; const sourceHash = "a".repeat(64); const url = publicUrl(sourceKey);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceId},${source.studioId},${sourceHash},${sourceKey},${url},4096,'video/mp4','video','upload',${source.userId},960,540,5.055)`;
  const body = structuredClone(BODY); body.project_id = target.projectId; body.space_id = randomUUID(); body.run_id = randomUUID();
  body.draft.draftId = randomUUID(); body.draft.revision = randomUUID(); body.draft.source.nodeId = randomUUID(); body.draft.source.canonicalURL = url; body.outputs[0]!.nodeId = randomUUID();
  const presented = await presentedSource(sourceHash, sourceKey, publicUrl);
  outside.snapshots.set(sourceKey, presented.snapshot);
  body.presentation_ref = presented.presentationRef;
  return { ...target, body, viewerId: await member(target.projectId, "viewer"), otherId: await member(target.projectId, "editor"), sourceId, sourceStudioId: source.studioId, sourceKey, sourceHash };
}
/** Create an isolated real Redis session; optional browser consent retains its existing cookie contract.
 * @throws {Error} On a session-store failure.
 */
async function cookie(userId: string, consent = false): Promise<string> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await setSession(getRedis(), token, userId);
  const choice = { revision: 1, categories: ["analytics"], data: { analytics: { decidedAt: new Date().toISOString(), source: "banner" }, ads: { decidedAt: new Date().toISOString(), source: "banner" } } };
  return `${sessionCookieName()}=${token}${consent ? `; breatic_consent=${encodeURIComponent(JSON.stringify(choice))}` : ""}`;
}
/** Exercise the actual route and original runOnce bytes, not a service mock.
 * @throws {Error} On a test-client or authentication-store failure.
 */
async function post(f: Fixture, body: unknown = f.body, key = randomUUID(), actor: string | null = f.userId, raw?: string, consent = false): Promise<Response> {
  return app.request("/api/v1/mini-tools", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...(actor ? { Cookie: await cookie(actor, consent) } : {}) }, body: raw ?? JSON.stringify(body) });
}
/** Count the original run only; neighboring tests/other holds cannot satisfy these observations.
 * @throws {Error} On a fixture SQL or queue read failure.
 */
async function counts(f: Fixture): Promise<{ tasks: number; rows: number; holds: number; queue: number }> {
  const [row] = await pg<{ tasks: number; rows: number; holds: number }[]>`SELECT
    (SELECT count(*)::int FROM tasks WHERE id=${f.body.run_id}) AS tasks,
    (SELECT count(*)::int FROM node_tasks WHERE task_id=${f.body.run_id}) AS rows,
    (SELECT count(*)::int FROM credit_holds WHERE reference_id=${f.body.run_id}) AS holds`;
  if (!row) throw new Error("Missing fixture counts"); return { ...row, queue: await queue.getJob(f.body.run_id) ? 1 : 0 };
}
/** Observe the durable task independently from its production mapper.
 * @throws {Error} If the accepted task disappeared.
 */
async function parent(f: Fixture): Promise<TaskRow> {
  const [row] = await pg<TaskRow[]>`SELECT status,params,result,error_message,billed_at::text FROM tasks WHERE id=${f.body.run_id}`;
  if (!row) throw new Error("Accepted fixture task disappeared"); return row;
}
/** Require success before extracting any later SQL or queue fixture observation.
 * @throws {Error} On a test-client or assertion failure.
 */
async function accepted(f: Fixture, response: Response): Promise<void> {
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ data: { task_id: f.body.run_id, status: "pending" } });
}
/** Open a run's one container job through the real plan owner, its consumption pending on its report (frames-split §5.4).
 * @throws {Error} When an owning persistence operation fails.
 */
async function openContainerJob(taskId: string): Promise<{ stepId: string; identity: MiniToolConsumptionIdentity }> {
  const [s] = await upstreamStepRepo.ensureSteps(taskId, [{ kind: "container_job", endpoint: "MiniToolContainerStd4", itemIndex: 0 }]); if (!s) throw new Error("Missing controlled worker step");
  const inputId = randomUUID();
  const request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId: `${taskId}:batch:0:a1`, containerClass: "MiniToolContainerStd4", deadlineAt: 4070908800000,
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, inputs: [{ inputId, storageKey: "video/source.mp4" }],
    outputs: [{ outputIndex: 0, storageKey: `planned/${taskId}/0.mp4`, contentType: "video/mp4", recipe: { kind: "segment", inputId,
      grid: { fps: { numerator: 200, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 1011, realFrameCount: 1011 },
      source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frames: { start: 0, end: 1011 },
      target: { width: 960, height: 540, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" }, audio: true } }] });
  const { consumption } = await openMiniToolPlanJob({ taskId, stepId: s.id, chunkIndex: 0, chargeTo: "user", request });
  return { stepId: s.id, identity: consumption.identity };
}
/** Create controlled worker-owned facts after a real queue add, without invoking or claiming a real container or worker run.
 * @throws {Error} When actual domain persistence fails.
 */
async function workerFacts(f: Fixture, completed: boolean): Promise<void> {
  const entered = await miniToolExecutionService.startMiniToolExecution(f.body.run_id, f.body.run_id);
  const { stepId } = await openContainerJob(f.body.run_id);
  if (!completed) return;
  const assetId = randomUUID(); const key = `video/ack-winner/${assetId}.webm`; const canonicalURL = publicUrl(key);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,generation_task_id,width,height,duration_seconds)
    VALUES (${assetId},${f.studioId},${OUTPUT_HASH},${key},${canonicalURL},1588436,'video/webm','video','ai',${f.userId},${f.body.run_id},960,540,5.013)`;
  await upstreamStepRepo.recordInline(stepId, { "miniToolAsset:0": assetId }, 0);
  await miniToolExecutionService.finishMiniToolExecution(f.body.run_id, { planFingerprint: entered.execution.planFingerprint, expectedVersion: 0, error: null,
    outputs: [{ ...entered.execution.outputs[0]!, late: false, result: { status: "registered", assetId, canonicalURL, contentHash: OUTPUT_HASH, kind: "video", mimeType: "video/webm", size: 1588436, width: 960, height: 540, duration: 5.013, cover: null } }] });
}

describe("planned POST real admission, strict body and original row/hold/queue owners", () => {
  it.each([false, true])("H01/A03 holds the full real quote in the target Studio and queues a strictly narrow original-consent job (consent=%s)", async (consent) => {
    const f = await seed(); await accepted(f, await post(f, f.body, randomUUID(), f.userId, undefined, consent));
    expect(f.sourceStudioId).not.toBe(f.studioId); expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
    const task = await parent(f); expect(task).toMatchObject({ status: "pending", params: { miniToolExecution: { binding: { assetId: f.sourceId, contentHash: f.sourceHash, canonicalURL: f.body.draft.source.canonicalURL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } }, sourceKey: f.sourceKey,
      credits: 5, model: "video.split", targetNodeIds: [f.body.outputs[0]!.nodeId], outputs: f.body.outputs } } });
    const rows = await pg`SELECT node_id,budget_ms,action FROM node_tasks WHERE task_id=${f.body.run_id}`; expect([...rows]).toEqual([{ node_id: f.body.outputs[0]!.nodeId, budget_ms: getNodeTaskConfig().default_budget_ms, action: "mini_tool" }]);
    const held = await pg`SELECT studio_id,actor_user_id,reference_id,amount::float8,status FROM credit_holds WHERE reference_id=${f.body.run_id}`; expect([...held]).toEqual([{ studio_id: f.studioId, actor_user_id: f.userId, reference_id: f.body.run_id, amount: 5, status: "held" }]);
    const job = await queue.getJob(f.body.run_id); expect(job?.name).toBe("execute-mini-tool"); expect(job?.id).toBe(f.body.run_id);
    expect(job?.data).toEqual({ taskId: f.body.run_id, source: "mini_tool", executionKind: "planned", analyticsConsent: consent ? { analytics: true, ads: false } : NO_CONSENT });
    const sourceRows = await pg`SELECT node_id FROM node_tasks WHERE node_id=${f.body.draft.source.nodeId}`; expect([...sourceRows]).toEqual([]);
  });
  it("H08/P2 quotes actual registered 5.055 rather than client media claims", async () => {
    const f = await seed(); f.body.draft.source.mediaInfo = { width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" };
    await accepted(f, await post(f)); expect((await parent(f)).params.miniToolExecution).toMatchObject({ credits: 5, binding: { mediaInfo: { width: 960, height: 540, duration: 5.055 } }, draft: f.body.draft });
  });
  it.each(["video/webm", "video/quicktime"])("P14 admits live registered %s metadata once its selected version is ready", async (mimeType) => {
    const f = await seed(); await pg`UPDATE studio_assets SET mime_type=${mimeType} WHERE id=${f.sourceId}`; await accepted(f, await post(f));
    expect((await parent(f)).params.miniToolExecution.binding.mediaInfo).toEqual({ width: 960, height: 540, duration: 5.055, mimeType });
  });
  it("P11 holds the already multiplied quote once", async () => {
    const f = await seed(); configure(true, 2); await accepted(f, await post(f)); expect((await parent(f)).params.miniToolExecution.credits).toBe(6.69);
    const [hold] = await pg`SELECT amount::float8 FROM credit_holds WHERE reference_id=${f.body.run_id}`; expect(hold).toEqual({ amount: 6.69 });
  });
  it("A01 unauthenticated requests have no admission side effects", async () => {
    const f = await seed(); expect((await post(f, f.body, randomUUID(), null)).status).toBe(401); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
  });
  it.each(["viewer", "archived", "missing membership", "missing project", "deleted project"])("A02 rejects %s before creating or reserving anything", async (bad) => {
    const f = await seed(); const actor = bad === "viewer" ? f.viewerId : f.userId;
    if (bad === "archived") await pg`UPDATE projects SET archived_at=clock_timestamp(),archived_by_user_id=${f.userId} WHERE id=${f.projectId}`;
    else if (bad === "missing membership") await pg`UPDATE project_members SET deleted_at=clock_timestamp() WHERE project_id=${f.projectId} AND user_id=${f.userId}`;
    else if (bad === "deleted project") await pg`UPDATE projects SET deleted_at=clock_timestamp() WHERE id=${f.projectId}`;
    else if (bad === "missing project") f.body.project_id = randomUUID();
    expect((await post(f, f.body, randomUUID(), actor)).status).toBe(bad === "viewer" || bad === "archived" ? 403 : 404); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
  });
  it.each(["foreign", "missing", "deleted", "image", "null width", "null height", "null duration", "invalid hash", "empty MIME"])("A04 rejects actual unavailable source %s without client metadata repair", async (bad) => {
    const f = await seed();
    if (bad === "foreign") f.body.draft.source.canonicalURL = "https://foreign.example.test/source.mp4";
    else if (bad === "missing") await pg`DELETE FROM studio_assets WHERE id=${f.sourceId}`;
    else if (bad === "deleted") await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.sourceId}`;
    else if (bad === "image") await pg`UPDATE studio_assets SET kind='image' WHERE id=${f.sourceId}`;
    else if (bad === "null width") await pg`UPDATE studio_assets SET width=null WHERE id=${f.sourceId}`;
    else if (bad === "null height") await pg`UPDATE studio_assets SET height=null WHERE id=${f.sourceId}`;
    else if (bad === "null duration") await pg`UPDATE studio_assets SET duration_seconds=null WHERE id=${f.sourceId}`;
    else if (bad === "invalid hash") await pg`UPDATE studio_assets SET content_hash='invalid' WHERE id=${f.sourceId}`;
    else await pg`UPDATE studio_assets SET mime_type='' WHERE id=${f.sourceId}`;
    expect((await post(f)).status).toBe(422); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
  });
  it.each(["tool", "project_id", "space_id", "run_id", "draft", "analysis_refs", "outputs"])("H02 rejects missing %s as request_shape", async (field) => {
    const f = await seed(); const body = { ...f.body }; Reflect.deleteProperty(body, field); const response = await post(f, body);
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { reason: "request_shape" } }); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
  });
  it.each(["provider", "model", "argv", "schemaVersion", "grants"])("H04-H05 rejects client execution capability %s", async (field) => {
    const f = await seed(); const capability = field === "provider" ? { provider: "wavespeed", model_id: "client-selected" } : field === "argv" ? ["-i", "private"] : field === "schemaVersion" ? 2 : field === "grants" ? { reads: ["private/source"] } : "client-selected"; const body = { ...f.body, [field]: capability }; expect((await post(f, body)).status).toBe(422); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
  });
  it.each(["version", "params", "recipe", "empty", "two", "index", "source target"])("H04-H07 refuses invalid complete plan %s", async (bad) => {
    const f = await seed(); const body = structuredClone(f.body);
    if (bad === "version") Object.assign(body.draft, { version: 2 }); else if (bad === "params") Object.assign(body.draft.params, { argv: ["-i", "private"] });
    else if (bad === "recipe") Object.assign(body.outputs[0]!.recipe, { argv: ["-i", "private"] });
    else if (bad === "empty") body.outputs = []; else if (bad === "two") body.outputs.push({ ...body.outputs[0]!, nodeId: randomUUID() });
    else if (bad === "index") body.outputs[0]!.outputIndex = 1; else body.outputs[0]!.nodeId = body.draft.source.nodeId;
    const response = await post(f, body); expect(response.status).toBe(422); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
  });
});

describe("HTTP press and durable SQL identity remain distinct (A05-A13)", () => {
  it("A05 holds the original press while the real claim is blocked and rejects a second arrival in progress", async () => {
    const f = await seed(); const key = randomUUID(); const raw = JSON.stringify(f.body);
    let entered!: () => void; let release!: () => void; const ready = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
    const owner = pg.begin(async (tx) => { await tx`LOCK TABLE tasks IN SHARE MODE`; entered(); await gate; }); await ready;
    const first = post(f, f.body, key, f.userId, raw); void first.catch(() => undefined);
    try {
      await waitUntilBlockedOn(pg, ["insert into", "tasks"], 1);
      const repeat = await post(f, f.body, key, f.userId, raw); expect(repeat.status).toBe(409); expect(repeat.headers.get("Idempotency-Status")).toBe("in_progress");
      release(); await owner; await accepted(f, await first); expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
    } finally { release(); await owner; await Promise.allSettled([first]); }
  });
  it("A06 returns the original done HTTP answer without re-opening rows, hold or queue", async () => {
    const f = await seed(); const key = randomUUID(); const first = await post(f, f.body, key); expect(first.status).toBe(201); const original = await first.json();
    const before = await parent(f); const repeat = await post(f, f.body, key); expect(repeat.status).toBe(201); expect(await repeat.json()).toEqual(original);
    expect(repeat.headers.get("Idempotency-Status")).toBe("done"); expect(repeat.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await parent(f)).toEqual(before); expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
  });
  it("A07 rejects reordered raw bytes under the same press even when canonical values agree", async () => {
    const f = await seed(); const key = randomUUID(); await accepted(f, await post(f, f.body, key)); const original = await parent(f);
    const reordered = { presentation_ref: f.body.presentation_ref, outputs: f.body.outputs, analysis_refs: f.body.analysis_refs, draft: f.body.draft, run_id: f.body.run_id, project_id: f.body.project_id, space_id: f.body.space_id, tool: f.body.tool };
    const repeat = await post(f, reordered, key); expect(repeat.status).toBe(422); expect(await parent(f)).toEqual(original); expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
  });
  it("A08/A10 replays SQL identity under a new press without current source resolution or catalog pricing", async () => {
    const f = await seed(); await accepted(f, await post(f)); const original = await parent(f);
    await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.sourceId}`; configure(true, 2, "");
    const reordered = { presentation_ref: f.body.presentation_ref, outputs: f.body.outputs, analysis_refs: f.body.analysis_refs, draft: f.body.draft, run_id: f.body.run_id, project_id: f.body.project_id, space_id: f.body.space_id, tool: f.body.tool };
    await accepted(f, await post(f, reordered)); expect(await parent(f)).toEqual(original); expect((await parent(f)).params.miniToolExecution.draft.revision).toBe(f.body.draft.revision);
    expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
  });
  it.each(["revision", "source", "target", "project", "space", "actor"])("A09 preserves the canonical SQL winner on a changed %s", async (field) => {
    const f = await seed(); await accepted(f, await post(f)); const original = await parent(f); const changed = structuredClone(f.body); let actor = f.userId;
    if (field === "revision") changed.draft.revision = randomUUID(); else if (field === "source") changed.draft.source.canonicalURL = "https://foreign.example.test/changed.mp4";
    else if (field === "target") changed.outputs[0]!.nodeId = randomUUID(); else if (field === "space") changed.space_id = randomUUID();
    else if (field === "actor") actor = f.otherId;
    else { const other = await seedStudioFixture(pg, "post-other"); changed.project_id = other.projectId; await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${other.projectId},${f.userId},'editor')`; }
    const response = await post(f, changed, randomUUID(), actor); expect(response.status).toBe(409); expect(await parent(f)).toEqual(original); expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
  });
  it("A11 accepts a self-consistent revision without inventing a latest-Yjs lookup", async () => {
    const f = await seed(); f.body.draft.revision = "00000000-0000-4000-8000-000000000001";
    await accepted(f, await post(f)); expect((await parent(f)).params.miniToolExecution.draft.revision).toBe(f.body.draft.revision);
  });
  it.each([false, true])("A12 observes two actual claim INSERT contenders before one row/hold/job is opened (different body=%s)", async (different) => {
    const f = await seed(); let entered!: () => void; let release!: () => void; const ready = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
    const owner = pg.begin(async (tx) => { await tx`LOCK TABLE tasks IN SHARE MODE`; entered(); await gate; }); await ready;
    const changed = structuredClone(f.body); if (different) changed.draft.revision = randomUUID();
    const first = post(f); const second = post(f, changed); void first.catch(() => undefined); void second.catch(() => undefined);
    try { await waitUntilBlockedOn(pg, ["insert into", "tasks"], 2); release(); await owner; const responses = await Promise.all([first, second]); expect(responses.map((r) => r.status).sort()).toEqual(different ? [201, 409] : [201, 201]);
      for (const response of responses) if (response.status === 201) await accepted(f, response);
      expect((await parent(f)).params.miniToolExecution.draft.revision).toBe(responses[0].status === 201 ? f.body.draft.revision : changed.draft.revision);
      expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
    } finally { release(); await owner; await Promise.allSettled([first, second]); }
  });
  it.each(["analysis", "legacy"] as const)("A13 refuses an existing %s task PK rather than replacing it", async (lane) => {
    const f = await seed(); const params = lane === "analysis" ? { analysis: { fixture: true } } : { fixture: "legacy" };
    await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params)
      VALUES (${f.body.run_id},${f.userId},${f.projectId},${f.body.space_id},${lane === "analysis" ? "mini_tool_analysis" : "video"},'append','mini_tool','pending',${pg.json(params)})`;
    const [before] = await pg`SELECT params,status FROM tasks WHERE id=${f.body.run_id}`; expect((await post(f)).status).toBe(409);
    const [after] = await pg`SELECT params,status FROM tasks WHERE id=${f.body.run_id}`; expect(after).toEqual(before); expect(await counts(f)).toEqual({ tasks: 1, rows: 0, holds: 0, queue: 0 });
  });
});

describe("existing credit and acknowledgement ownership (A14-A17 / preparation A14-A17)", () => {
  it.each(["no_credits", "credits_held"] as const)("A15 refuses %s after opening only the original target row", async (reason) => {
    // The lot covers the 5-credit split quote, so a 1-credit hold leaves it short only by the hold.
    const f = await seed(reason === "no_credits" ? 0 : 5);
    if (reason === "credits_held") await creditHoldService.reserveCredits({ projectId: f.projectId, actorUserId: f.userId, referenceId: randomUUID(), amount: 1, ttlMs: getNodeTaskConfig().default_budget_ms });
    const response = await post(f); expect(response.status).toBe(201); expect(await response.json()).toEqual({ data: { task_id: f.body.run_id, status: "failed" } });
    const task = await parent(f); expect(task.status).toBe("failed"); expect(task.error_message).toBe(reason);
    const rows = await pg`SELECT node_id,status,error_message FROM node_tasks WHERE task_id=${f.body.run_id}`; expect([...rows]).toEqual([{ node_id: f.body.outputs[0]!.nodeId, status: "failed", error_message: reason }]);
    expect(await queue.getJob(f.body.run_id)).toBeUndefined();
    const held = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.body.run_id} AND status='held'`; expect([...held]).toEqual([]);
    // A split refused at admission stays retryable (frames-split §7.15), so its execution pin outlives the refusal.
    const pins = await pg`SELECT holder_kind FROM presentation_pins WHERE holder_id=${f.body.run_id} AND deleted_at IS NULL`; expect([...pins]).toEqual([{ holder_kind: "execution" }]);
  });
  it("A16 payment-disabled admission keeps the real quote and queue but opens no hold", async () => {
    const f = await seed(); configure(false); await accepted(f, await post(f)); expect((await parent(f)).params.miniToolExecution.credits).toBe(5);
    expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 0, queue: 1 });
  });
  it("A17 records the actual claim persistence failure rather than treating it as replay", async () => {
    const f = await seed();
    await pg.unsafe(`CREATE FUNCTION reject_planned_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.body.run_id}'::uuid THEN RAISE EXCEPTION 'fixture_planned_claim_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_planned_claim BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION reject_planned_claim()");
    const errorLog = vi.spyOn(logger, "error");
    try {
      expect((await post(f)).status).toBe(500);
      expect(errorLog.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining("fixture_planned_claim_failed") }) }) })])]));
      expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
    } finally { errorLog.mockRestore(); await pg.unsafe("DROP TRIGGER reject_planned_claim ON tasks"); await pg.unsafe("DROP FUNCTION reject_planned_claim()"); }
  });
  it.each(["before add", "after persisted identity", "after completed media"] as const)("preparation A16/A17 handles controlled queue acknowledgement failure %s", async (stage) => {
    const f = await seed();
    const intercepted = vi.spyOn(Queue.prototype, "add").mockImplementation(async function (this: Queue, name: string, data: unknown, opts?: JobsOptions): Promise<Job> {
      if (typeof data !== "object" || data === null || !("taskId" in data) || data.taskId !== f.body.run_id) return add.call(this, name, data, opts);
      if (stage !== "before add") { await add.call(this, name, data, opts); await workerFacts(f, stage === "after completed media"); }
      throw ACK_ERROR;
    });
    try {
      const response = await post(f); expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ data: { task_id: f.body.run_id } });
      const task = await parent(f); expect(task.status).toBe(stage === "after completed media" ? "completed" : "failed");
      const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.body.run_id}`; expect(hold).toEqual({ status: stage === "before add" ? "released" : "held" });
      if (stage === "before add") expect(task.result?.settlement).toMatchObject({ consumptionSetComplete: true });
      else {
        expect(task.result?.miniToolExecution).toMatchObject({ usage: [{ state: "pending", chargeTo: "user", costUsd: null, credits: null }] });
        expect(task.billed_at).toBeNull(); expect(await queue.getJob(f.body.run_id)).toMatchObject({ id: f.body.run_id, name: "execute-mini-tool" });
        if (stage === "after completed media") expect(task.result?.miniToolExecution).toMatchObject({ status: "completed", resultVersion: 1, outputs: [{ result: { status: "registered", kind: "video", duration: 5.013, contentHash: OUTPUT_HASH } }] });
        else expect(task.result?.settlement).toMatchObject({ consumptionSetComplete: false });
      }
    } finally { intercepted.mockRestore(); }
  });
});

/** Reserve through the real credit owner for an independently seeded accepted execution.
 * @throws {Error} On funding or reservation failure.
 */
async function holdExecution(f: ExecutionFixture): Promise<void> {
  await seedDesignatedLot(pg, f, 1000);
  const reserved = await creditHoldService.reserveCredits({ projectId: f.projectId, actorUserId: f.userId, referenceId: f.taskId, amount: 30, ttlMs: getNodeTaskConfig().default_budget_ms });
  expect(reserved.ok).toBe(true);
}
/** Open the run's container job, its consumption pending on its report.
 * @throws {Error} When an owning persistence operation fails.
 */
async function executionIdentity(f: ExecutionFixture): Promise<{ stepId: string; consumptionKey: string }> {
  const { stepId, identity } = await openContainerJob(f.taskId);
  return { stepId, consumptionKey: await miniToolConsumptionKey({ taskId: f.taskId, stepId, identity }) };
}

describe("planned admission failure shares the original task lock and settlement owner", () => {
  it("preparation A16 fails a no-call accepted task, closes its empty set and releases the actual held quote", async () => {
    const f = await seedExecution(pg, "pending", false); await holdExecution(f);
    const record = await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" });
    expect(record).toMatchObject({ runId: f.taskId, status: "failed", resultVersion: 1, error: { code: "internal" }, outputs: [{ ...f.plan.outputs[0], result: { status: "failed", error: { code: "internal" } } }] });
    const parent = await executionSnapshot(pg, f); expect(parent.status).toBe("failed"); expect(parent.params).toEqual({ miniToolExecution: f.plan }); expect(parent.result.preserved).toEqual({ token: "original" }); expect(parent.result.settlement).toMatchObject({ consumptionSetComplete: true });
    const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "released" });
  });
  it("preparation A17 retains the actual held quote and an opened container job's pending expense", async () => {
    const f = await seedExecution(pg, "running"); await holdExecution(f); const i = await executionIdentity(f); const beforeSteps = await upstreamStepRepo.listSteps(f.taskId);
    const record = await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" }); expect(record.status).toBe("failed");
    expect(record.usage).toEqual([{ consumptionKey: i.consumptionKey, state: "pending", chargeTo: "user", costUsd: null, credits: null }]);
    expect(await upstreamStepRepo.listSteps(f.taskId)).toEqual(beforeSteps); const parent = await executionSnapshot(pg, f); expect(parent.billed_at).toBeNull();
    const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
  });
  it("preparation A17 keeps committed completion and pending actual expense when a queue acknowledgement later fails", async () => {
    const f = await seedExecution(pg, "running"); await holdExecution(f); await executionIdentity(f);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, { planFingerprint: f.plan.planFingerprint, expectedVersion: 0, outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }], error: null });
    const before = await executionSnapshot(pg, f); const record = await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" });
    expect(record.status).toBe("completed"); expect(await executionSnapshot(pg, f)).toEqual(before); const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
  });
  it("rolls back failure metadata and actual hold release together if the namespace cannot be saved", async () => {
    const f = await seedExecution(pg); await holdExecution(f); const before = await executionSnapshot(pg, f);
    await pg.unsafe(`CREATE FUNCTION reject_planned_admission_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result->'miniToolExecution' IS DISTINCT FROM OLD.result->'miniToolExecution' THEN RAISE EXCEPTION 'fixture_admission_failure_write_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_planned_admission_failure BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_planned_admission_failure()");
    try { await expect(miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_admission_failure_write_failed") } }); }
    finally { await pg.unsafe("DROP TRIGGER reject_planned_admission_failure ON tasks"); await pg.unsafe("DROP FUNCTION reject_planned_admission_failure()"); }
    expect(await executionSnapshot(pg, f)).toEqual(before); const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
  });
});
