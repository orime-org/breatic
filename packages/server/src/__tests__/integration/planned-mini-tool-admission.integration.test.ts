// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real HTTP middleware, PG roles/assets/tasks/rows/credit holds and BullMQ. No supplier or media is invoked.
 *
 * S6e E3b (inner#1306 test plan §90): the removal request names its tool input; the ingest presentation read and the
 * full/compact objects are controlled at the shared client and `fetch`. The frozen body's video is the prepared reference
 * and the quote is the model's (30 for 5.055 s) plus the standard-4 preparation at its 300 s floor (the 5-credit
 * minimum at multiplier 1; 6.69 at multiplier 2).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { Queue, type Job, type JobsOptions } from "bullmq";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import {
  createPgClient, createQueue, getNodeTaskConfig, getRedis, getStorageAdapter, initCore, initLogger,
  loadLocales, logger, revokeSession, sessionCookieName, setSession,
} from "@breatic/core";
import type * as shared from "@breatic/shared";
import { NO_CONSENT } from "@breatic/shared";
import { miniToolConsumptionKey, miniToolExecutionRecordSchema, type MiniToolPlannedRequest } from "@breatic/shared/mini-tools";
import {
  beginMiniToolStepAttempt, creditHoldService, miniToolExecutionService, modelCatalog,
  recordMiniToolStepIdentity, recordMiniToolStepResult, taskRepo, upstreamStepRepo,
  type AcceptedMiniToolExecution,
} from "@breatic/domain";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { executionSnapshot, seedExecution, type ExecutionFixture } from "../../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";
import { presentedSource } from "./presentation-fixtures.js";

const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));

const BODY: Extract<MiniToolPlannedRequest, { tool: "video.remove-bg" }> = {
  tool: "video.remove-bg",
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
    params: {},
  },
  analysis_refs: [],
  outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "remove-bg" } }],
  // Each seed replaces this with its source's selected tool input (E3b).
  presentation_ref: { source: { toolInputId: "0".repeat(64), planSha256: "0".repeat(64) } },
};

interface Fixture extends StudioFixture { body: Extract<MiniToolPlannedRequest, { tool: "video.remove-bg" }>; viewerId: string; otherId: string; sourceId: string; sourceStudioId: string; sourceKey: string; sourceHash: string }
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
afterAll(async () => { for (const token of tokens) await revokeSession(getRedis(), token); await pg.end(); initCore(process.env); modelCatalog.resetModelCatalog(); vi.unstubAllGlobals(); });

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
/** Create controlled worker-owned facts after a real queue add, without invoking or claiming a real provider/worker run.
 * @throws {Error} When actual domain persistence fails.
 */
async function workerFacts(f: Fixture, completed: boolean): Promise<void> {
  const entered = await miniToolExecutionService.startMiniToolExecution(f.body.run_id, f.body.run_id);
  if (entered.execution.tool !== "video.remove-bg") throw new Error("Expected removal fixture plan");
  const [s] = await upstreamStepRepo.ensureSteps(f.body.run_id, [{ kind: "generate", endpoint: entered.execution.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing controlled worker step");
  const deadlineAt = entered.task.createdAt.getTime() + getNodeTaskConfig().default_budget_ms; const attemptId = randomUUID();
  await beginMiniToolStepAttempt({ taskId: f.body.run_id, stepId: s.id, attemptId, deadlineAt, requestBody: { ...entered.execution.body }, chargeTo: "user" });
  await recordMiniToolStepIdentity({ taskId: f.body.run_id, stepId: s.id, attemptId, predictionId: "controlled-ack-prediction" });
  if (!completed) return;
  const url = "https://provider.example.test/controlled-result.webm";
  await recordMiniToolStepResult({ taskId: f.body.run_id, stepId: s.id, identity: { kind: "provider", provider: "wavespeed", predictionId: "controlled-ack-prediction" }, outcome: "done", result: [url] },
    { kind: "generate", parse: (value) => ({ providerURL: z.tuple([z.string().url()]).parse(value)[0] }) });
  const assetId = randomUUID(); const key = `video/ack-winner/${assetId}.webm`; const canonicalURL = publicUrl(key);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,generation_task_id,width,height,duration_seconds)
    VALUES (${assetId},${f.studioId},${OUTPUT_HASH},${key},${canonicalURL},1588436,'video/webm','video','ai',${f.userId},${f.body.run_id},960,540,5.013)`;
  await upstreamStepRepo.recordInline(s.id, { "miniToolAsset:0": assetId }, 0);
  await miniToolExecutionService.finishMiniToolExecution(f.body.run_id, { planFingerprint: entered.execution.planFingerprint, expectedVersion: 0, error: null,
    outputs: [{ ...entered.execution.outputs[0]!, late: false, result: { status: "registered", assetId, canonicalURL, contentHash: OUTPUT_HASH, kind: "video", mimeType: "video/webm", size: 1588436, width: 960, height: 540, duration: 5.013, cover: null } }] });
}

describe("planned POST real admission, strict body and original row/hold/queue owners", () => {
  it.each([false, true])("H01/A03 holds the full real quote in the target Studio and queues a strictly narrow original-consent job (consent=%s)", async (consent) => {
    const f = await seed(); await accepted(f, await post(f, f.body, randomUUID(), f.userId, undefined, consent));
    expect(f.sourceStudioId).not.toBe(f.studioId); expect(await counts(f)).toEqual({ tasks: 1, rows: 1, holds: 1, queue: 1 });
    const task = await parent(f); expect(task).toMatchObject({ status: "pending", params: { miniToolExecution: { binding: { assetId: f.sourceId, contentHash: f.sourceHash, canonicalURL: f.body.draft.source.canonicalURL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } }, sourceKey: f.sourceKey,
      body: { video: { kind: "prepared", inputId: "source", job: `${f.body.run_id}:prep:0` }, background_color: "Transparent", output_container_and_codec: "webm_vp9", preserve_audio: true }, credits: 35, model: "bria-fibo-video-background-remover", targetNodeIds: [f.body.outputs[0]!.nodeId], outputs: f.body.outputs } } });
    const rows = await pg`SELECT node_id,budget_ms,action FROM node_tasks WHERE task_id=${f.body.run_id}`; expect([...rows]).toEqual([{ node_id: f.body.outputs[0]!.nodeId, budget_ms: getNodeTaskConfig().default_budget_ms, action: "mini_tool" }]);
    const held = await pg`SELECT studio_id,actor_user_id,reference_id,amount::float8,status FROM credit_holds WHERE reference_id=${f.body.run_id}`; expect([...held]).toEqual([{ studio_id: f.studioId, actor_user_id: f.userId, reference_id: f.body.run_id, amount: 35, status: "held" }]);
    const job = await queue.getJob(f.body.run_id); expect(job?.name).toBe("execute-mini-tool"); expect(job?.id).toBe(f.body.run_id);
    expect(job?.data).toEqual({ taskId: f.body.run_id, source: "mini_tool", executionKind: "planned", analyticsConsent: consent ? { analytics: true, ads: false } : NO_CONSENT });
    const sourceRows = await pg`SELECT node_id FROM node_tasks WHERE node_id=${f.body.draft.source.nodeId}`; expect([...sourceRows]).toEqual([]);
  });
  it("H08/P2 quotes actual registered 5.055 rather than client media claims", async () => {
    const f = await seed(); f.body.draft.source.mediaInfo = { width: 16, height: 16, duration: 0.1, mimeType: "video/mp4" };
    await accepted(f, await post(f)); expect((await parent(f)).params.miniToolExecution).toMatchObject({ credits: 35, binding: { mediaInfo: { width: 960, height: 540, duration: 5.055 } }, draft: f.body.draft });
  });
  it.each(["video/webm", "video/quicktime"])("P14 admits live registered %s metadata once its selected version is ready", async (mimeType) => {
    const f = await seed(); await pg`UPDATE studio_assets SET mime_type=${mimeType} WHERE id=${f.sourceId}`; await accepted(f, await post(f));
    expect((await parent(f)).params.miniToolExecution.binding.mediaInfo).toEqual({ width: 960, height: 540, duration: 5.055, mimeType });
  });
  it("P11 holds the already multiplied quote once", async () => {
    const f = await seed(); configure(true, 2); await accepted(f, await post(f)); expect((await parent(f)).params.miniToolExecution.credits).toBe(66.69);
    const [hold] = await pg`SELECT amount::float8 FROM credit_holds WHERE reference_id=${f.body.run_id}`; expect(hold).toEqual({ amount: 66.69 });
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
  it("A14 rejects an unavailable real catalog before claim instead of using a fallback quote", async () => {
    const f = await seed(); configure(true, 1, ""); expect((await post(f)).status).toBe(503); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
  });
  it("A20 freezes the route the model was measured on into the plan (inner#1306 §11.2 route row)", async () => {
    const f = await seed(); await accepted(f, await post(f));
    expect((await parent(f)).params.miniToolExecution).toMatchObject({ model: "bria-fibo-video-background-remover", route: { mode: "upstream", upstream: "wavespeed" } });
  });
  it("A21 refuses before claim a call longer than the model's vendor limit (inner#1306 §11.5)", async () => {
    const f = await seed(); await pg`UPDATE studio_assets SET duration_seconds=61 WHERE id=${f.sourceId}`;
    const response = await post(f); expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { reason: "input_refused" } }); expect(await counts(f)).toEqual({ tasks: 0, rows: 0, holds: 0, queue: 0 });
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
  it("A18 a failed-output removal retry holds only the frozen model quote, so a balance of 30 covers it (inner#1306 §90 E3b)", async () => {
    const f = await seed(35); await accepted(f, await post(f)); const plan = (await parent(f)).params.miniToolExecution;
    // The original finished its preparation, registered with its prepared pin (design §7.15 prepared 行); seeded directly here.
    const preparedKey = `${plan.sourceKey}.${f.body.run_id}:prep:0:a1`;
    const [prepared] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id,prepared_key)
      VALUES ('prepared',${f.body.run_id},${f.body.presentation_ref.source.toolInputId},${preparedKey}) RETURNING id`;
    await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${prepared!.id},${preparedKey})`;
    const record = miniToolExecutionRecordSchema.parse({ schemaVersion: 1, runId: f.body.run_id, status: "failed", planFingerprint: plan.planFingerprint,
      resultVersion: 1, sourceBindings: [plan.binding], outputs: plan.outputs.map((output) => ({ ...output, late: false, result: { status: "failed", error: { code: "provider_failed" } } })),
      usage: [], billingState: "idle", error: { code: "provider_failed" } });
    await pg`UPDATE tasks SET status='failed',result=${pg.json(z.json().parse({ miniToolExecution: record }))},completed_at=clock_timestamp() WHERE id=${f.body.run_id}`;
    await pg`UPDATE node_tasks SET status='failed',settled_at=clock_timestamp() WHERE task_id=${f.body.run_id}`;
    await creditHoldService.releaseHold(f.body.run_id);
    // Leave exactly the 30-credit model quote available: the preparation is not rerun, so it is not held again.
    await creditHoldService.reserveCredits({ projectId: f.projectId, actorUserId: f.userId, referenceId: randomUUID(), amount: 5, ttlMs: getNodeTaskConfig().default_budget_ms });
    const retry = { tool: "video.remove-bg", project_id: f.body.project_id, space_id: f.body.space_id, run_id: randomUUID(), retry: { runId: f.body.run_id, outputIndexes: [0] } };
    const response = await post(f, retry);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 201, body: { data: { task_id: retry.run_id, status: "pending" } } });
    const held = await pg`SELECT amount::float8,status FROM credit_holds WHERE reference_id=${retry.run_id}`;
    expect([...held]).toEqual([{ amount: 30, status: "held" }]);
  });
  it("A19 a removal retry whose original never finished preparing holds the full frozen quote and prepares under its own task (frames-split retry row)", async () => {
    const f = await seed(35); await accepted(f, await post(f)); const plan = (await parent(f)).params.miniToolExecution;
    // The original's preparation failed, so it holds no prepared input a retry could reuse.
    const record = miniToolExecutionRecordSchema.parse({ schemaVersion: 1, runId: f.body.run_id, status: "failed", planFingerprint: plan.planFingerprint,
      resultVersion: 1, sourceBindings: [plan.binding], outputs: plan.outputs.map((output) => ({ ...output, late: false, result: { status: "failed", error: { code: "mini_tool_failed" } } })),
      usage: [], billingState: "idle", error: { code: "mini_tool_failed" } });
    await pg`UPDATE tasks SET status='failed',result=${pg.json(z.json().parse({ miniToolExecution: record }))},completed_at=clock_timestamp() WHERE id=${f.body.run_id}`;
    await pg`UPDATE node_tasks SET status='failed',settled_at=clock_timestamp() WHERE task_id=${f.body.run_id}`;
    await creditHoldService.releaseHold(f.body.run_id);
    const retry = { tool: "video.remove-bg", project_id: f.body.project_id, space_id: f.body.space_id, run_id: randomUUID(), retry: { runId: f.body.run_id, outputIndexes: [0] } };
    const response = await post(f, retry);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 201, body: { data: { task_id: retry.run_id, status: "pending" } } });
    const held = await pg`SELECT amount::float8,status FROM credit_holds WHERE reference_id=${retry.run_id}`;
    expect([...held]).toEqual([{ amount: 35, status: "held" }]);
    const [frozen] = await pg<{ params: { miniToolExecution: { credits: number; body: { video: { job: string } } } } }[]>`SELECT params FROM tasks WHERE id=${retry.run_id}`;
    expect(frozen!.params.miniToolExecution).toMatchObject({ credits: 35, body: { video: { job: `${retry.run_id}:prep:0` } } });
    const pins = await pg`SELECT holder_kind FROM presentation_pins WHERE holder_id=${retry.run_id} AND deleted_at IS NULL`;
    expect([...pins]).toEqual([{ holder_kind: "execution" }]);
  });
  it("E4-RB01 a removal retry pins L and the reused prepared input for itself, and releases the original's pins in its admission (inner#1306 §90 E4-5)", async () => {
    const f = await seed(); await accepted(f, await post(f)); const plan = (await parent(f)).params.miniToolExecution;
    // The original's preparation was registered with its prepared pin (design §7.15 prepared 行); seeded directly here.
    const preparedKey = `${plan.sourceKey}.${f.body.run_id}:prep:0:a1`;
    const [prepared] = await pg<{ id: string }[]>`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id,prepared_key)
      VALUES ('prepared',${f.body.run_id},${f.body.presentation_ref.source.toolInputId},${preparedKey}) RETURNING id`;
    await pg`INSERT INTO presentation_pin_objects (pin_id,storage_key) VALUES (${prepared!.id},${preparedKey})`;
    const record = miniToolExecutionRecordSchema.parse({ schemaVersion: 1, runId: f.body.run_id, status: "failed", planFingerprint: plan.planFingerprint,
      resultVersion: 1, sourceBindings: [plan.binding], outputs: plan.outputs.map((output) => ({ ...output, late: false, result: { status: "failed", error: { code: "provider_failed" } } })),
      usage: [], billingState: "idle", error: { code: "provider_failed" } });
    await pg`UPDATE tasks SET status='failed',result=${pg.json(z.json().parse({ miniToolExecution: record }))},completed_at=clock_timestamp() WHERE id=${f.body.run_id}`;
    await pg`UPDATE node_tasks SET status='failed',settled_at=clock_timestamp() WHERE task_id=${f.body.run_id}`;
    await creditHoldService.releaseHold(f.body.run_id);
    const retry = { tool: "video.remove-bg", project_id: f.body.project_id, space_id: f.body.space_id, run_id: randomUUID(), retry: { runId: f.body.run_id, outputIndexes: [0] } };
    expect((await post(f, retry)).status).toBe(201);
    const pins = await pg<{ holder_id: string; holder_kind: string; prepared_key: string | null; keys: string[] }[]>`
      SELECT p.holder_id,p.holder_kind,p.prepared_key,coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL),'{}') AS keys
      FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
      WHERE p.holder_id IN (${f.body.run_id},${retry.run_id}) AND p.deleted_at IS NULL GROUP BY p.id ORDER BY p.holder_kind`;
    expect(pins.map(({ holder_id, holder_kind, prepared_key }) => ({ holder_id, holder_kind, prepared_key }))).toEqual([
      { holder_id: retry.run_id, holder_kind: "execution", prepared_key: null },
      { holder_id: retry.run_id, holder_kind: "prepared", prepared_key: preparedKey },
    ]);
    expect(pins[1]!.keys).toEqual([preparedKey]);
    const queued = await pg`SELECT storage_key FROM storage_reclaim_queue WHERE starts_with(storage_key, ${plan.sourceKey})`;
    expect([...queued]).toEqual([]);
  });
  it.each(["no_credits", "credits_held"] as const)("A15 refuses %s after opening only the original target row", async (reason) => {
    // The lot covers the 35-credit removal quote (model 30 + preparation 5), so a 30-credit hold leaves it short only by the hold.
    const f = await seed(reason === "no_credits" ? 0 : 35);
    if (reason === "credits_held") await creditHoldService.reserveCredits({ projectId: f.projectId, actorUserId: f.userId, referenceId: randomUUID(), amount: 30, ttlMs: getNodeTaskConfig().default_budget_ms });
    const response = await post(f); expect(response.status).toBe(201); expect(await response.json()).toEqual({ data: { task_id: f.body.run_id, status: "failed" } });
    const task = await parent(f); expect(task.status).toBe("failed"); expect(task.error_message).toBe(reason);
    const rows = await pg`SELECT node_id,status,error_message FROM node_tasks WHERE task_id=${f.body.run_id}`; expect([...rows]).toEqual([{ node_id: f.body.outputs[0]!.nodeId, status: "failed", error_message: reason }]);
    expect(await queue.getJob(f.body.run_id)).toBeUndefined();
    const held = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.body.run_id} AND status='held'`; expect([...held]).toEqual([]);
    // A removal refused at admission stays retryable (frames-split §7.15), so its execution pin outlives the refusal.
    const pins = await pg`SELECT holder_kind FROM presentation_pins WHERE holder_id=${f.body.run_id} AND deleted_at IS NULL`; expect([...pins]).toEqual([{ holder_kind: "execution" }]);
  });
  it("A16 payment-disabled admission keeps the real quote and queue but opens no hold", async () => {
    const f = await seed(); configure(false); await accepted(f, await post(f)); expect((await parent(f)).params.miniToolExecution.credits).toBe(35);
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
/** Prepare an original durable intent and optional original receipt under actual SQL owners.
 * @throws {Error} When an owning persistence operation fails.
 */
async function executionIdentity(f: ExecutionFixture, saveId: boolean): Promise<{ stepId: string; attemptId: string; consumptionKey: string }> {
  const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing admission fixture step");
  const task = await taskRepo.getMiniToolExecutionTask(f.taskId); if (!task) throw new Error("Missing admission fixture task");
  const attemptId = randomUUID(); await beginMiniToolStepAttempt({ taskId: f.taskId, stepId: s.id, attemptId,
    deadlineAt: task.createdAt.getTime() + getNodeTaskConfig().default_budget_ms, requestBody: { ...f.plan.body }, chargeTo: "user" });
  if (saveId) await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: s.id, attemptId, predictionId: "original-admission-prediction" });
  return { stepId: s.id, attemptId, consumptionKey: await miniToolConsumptionKey({ taskId: f.taskId, stepId: s.id, identity: { kind: "provider", provider: "wavespeed", predictionId: "original-admission-prediction" } }) };
}

describe("planned admission failure shares the original task lock and settlement owner", () => {
  it("preparation A16 fails a no-call accepted task, closes its empty set and releases the actual held quote", async () => {
    const f = await seedExecution(pg, "pending", false); await holdExecution(f);
    const record = await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" });
    expect(record).toMatchObject({ runId: f.taskId, status: "failed", resultVersion: 1, error: { code: "internal" }, outputs: [{ ...f.plan.outputs[0], result: { status: "failed", error: { code: "internal" } } }] });
    const parent = await executionSnapshot(pg, f); expect(parent.status).toBe("failed"); expect(parent.params).toEqual({ miniToolExecution: f.plan }); expect(parent.result.preserved).toEqual({ token: "original" }); expect(parent.result.settlement).toMatchObject({ consumptionSetComplete: true });
    const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "released" });
  });
  it.each([false, true])("preparation A17 retains the actual held quote and durable original intent/identity (identity=%s)", async (saveId) => {
    const f = await seedExecution(pg, "running"); await holdExecution(f); const i = await executionIdentity(f, saveId); const beforeSteps = await upstreamStepRepo.listSteps(f.taskId);
    const record = await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" }); expect(record.status).toBe("failed");
    expect(record.usage).toEqual(saveId ? [{ consumptionKey: i.consumptionKey, state: "pending", chargeTo: "user", costUsd: null, credits: null }] : []);
    expect(await upstreamStepRepo.listSteps(f.taskId)).toEqual(beforeSteps); const parent = await executionSnapshot(pg, f); expect(parent.result.settlement).toMatchObject({ consumptionSetComplete: false }); expect(parent.billed_at).toBeNull();
    const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
  });
  it("preparation A17 keeps committed completion and pending actual expense when a queue acknowledgement later fails", async () => {
    const f = await seedExecution(pg, "running"); await holdExecution(f); await executionIdentity(f, true);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, { planFingerprint: f.plan.planFingerprint, expectedVersion: 0, outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }], error: null });
    const before = await executionSnapshot(pg, f); const record = await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" });
    expect(record.status).toBe("completed"); expect(await executionSnapshot(pg, f)).toEqual(before); const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
  });
  it("serializes admission failure and recovery of an original prepared receipt on the same actual task lock", async () => {
    const f = await seedExecution(pg, "running"); await holdExecution(f); const i = await executionIdentity(f, false);
    let entered!: () => void; let release!: () => void; const ready = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
    const owner = pg.begin(async (tx) => { await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; entered(); await gate; }); await ready;
    const failing = miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, { code: "internal" });
    const receipt = recordMiniToolStepIdentity({ taskId: f.taskId, stepId: i.stepId, attemptId: i.attemptId, predictionId: "original-admission-prediction" }); void failing.catch(() => undefined); void receipt.catch(() => undefined);
    try { await waitUntilBlockedOn(pg, ["tasks", "for update"], 2); release(); await owner; await Promise.all([failing, receipt]);
      const parent = await executionSnapshot(pg, f); expect(parent.status).toBe("failed"); expect(parent.result.miniToolExecution).toMatchObject({ usage: [{ consumptionKey: i.consumptionKey, state: "pending", costUsd: null, credits: null }] });
      const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
    } finally { release(); await owner; await Promise.allSettled([failing, receipt]); }
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
