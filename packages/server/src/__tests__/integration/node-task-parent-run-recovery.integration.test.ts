// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Real PG node-task/parent/history identities and real project-scoped HTTP; no provider or media IO. */
import { randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createPgClient, getNodeTaskConfig, getRedis, getStorageAdapter, getStreamRedis, initCore,
  initLogger, loadLocales, logger, revokeSession, sessionCookieName, setSession, taskEventsStreamKey,
} from "@breatic/core";
import { miniToolExecutionRecordSchema, type MiniToolPlannedRequest } from "@breatic/shared/mini-tools";
import {
  miniToolExecutionService, modelCatalog, nodeHistoryService, nodeTaskService, openMiniToolPlanJob, upstreamStepRepo, initProvider,
} from "@breatic/domain";
import { miniToolPlanJobRequestSchema, type NodeTaskEntry } from "@breatic/shared";
import * as nodeTaskRepo from "../../../../domain/src/node-task/node-task.repo.js";
import { executionSnapshot, seedExecution, type ExecutionFixture } from "../../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";
import { seedDesignatedLot, seedStudioFixture } from "./studio-credit-fixtures.js";
import type * as shared from "@breatic/shared";
import { presentedSource } from "./presentation-fixtures.js";

// S6e E3b (inner#1306 §90): a split request names its tool input; the ingest presentation read and the stored
// full/compact objects are controlled at the shared client and `fetch`.
const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>(), ingest: vi.fn() }));
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof shared>(), videoPresentationAtIngest: outside.ingest }));

interface WireEntry extends NodeTaskEntry { taskId: string | null }
let pg: ReturnType<typeof createPgClient>;
let app: Hono;
const tokens: string[] = [];

beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "unused-parent-run-test", STRIPE_SECRET_KEY: "sk_test_unused", STRIPE_WEBHOOK_SECRET: "whsec_unused", UPLOAD_BASE_URL: "https://assets.example.test" });
  initProvider(); modelCatalog.resetModelCatalog(); loadLocales(); initLogger("node-parent-run-test");
  pg = createPgClient(inject("DATABASE_URL"), { name: "node-parent-run-fixture", max: 4 });
  const { createApp } = await import("@server/app.js"); app = createApp();
  outside.ingest.mockImplementation(async (_url: string, _secret: string, input: { storageKey: string }): Promise<unknown> => structuredClone(outside.snapshots.get(input.storageKey)));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const body = outside.bodies.get(input instanceof Request ? input.url : String(input));
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => {
  for (const token of tokens) await revokeSession(getRedis(), token);
  await pg?.end(); initCore(process.env); initProvider(); modelCatalog.resetModelCatalog(); vi.unstubAllGlobals();
});

/** Authenticate against real Redis rather than bypassing route middleware.
 * @throws {Error} When the isolated session store fails.
 */
async function cookie(userId: string): Promise<string> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}
/** Open a real node-task row with its distinct persistent parent foreign key.
 * @throws {Error} When the original node-task owner refuses the fixture.
 */
async function open(f: ExecutionFixture, nodeId = f.plan.targetNodeIds[0]!, action: "mini_tool" | "generate" | "upload" = "mini_tool", parent: string | null = f.taskId, label = "video.split"): Promise<string> {
  const row = await nodeTaskService.open({ projectId: f.projectId, spaceId: f.plan.spaceId, nodeId, kind: action === "upload" ? "upload" : "generation", action,
    startedByUserId: f.userId, budgetMs: getNodeTaskConfig().default_budget_ms, label, ...(parent === null ? {} : { taskId: parent }) });
  return row.id;
}
/** Read the original node list through Hono and inspect its actual JSON projection.
 * @throws {Error} When authentication, HTTP or the expected list shape fails.
 */
async function list(f: ExecutionFixture, userId: string | null = f.userId, nodeId = f.plan.targetNodeIds[0]!, projectId = f.projectId): Promise<{ response: Response; rows: WireEntry[] }> {
  const response = await app.request(`/api/v1/canvas/nodes/${nodeId}/tasks?project_id=${projectId}&space_id=${f.plan.spaceId}`,
    { headers: userId === null ? {} : { Cookie: await cookie(userId) } });
  const body: unknown = await response.clone().json();
  const parsed = z.object({ data: z.object({ tasks: z.array(z.unknown()) }) }).safeParse(body);
  return { response, rows: parsed.success ? parsed.data.data.tasks as WireEntry[] : [] };
}
/** Read only the actual existing project execution resource, never the actor-only task endpoint.
 * @throws {Error} When the test HTTP or session store fails.
 */
async function parentGet(f: ExecutionFixture, userId = f.viewerId, projectId = f.projectId): Promise<Response> {
  return app.request(`/api/v1/projects/${projectId}/mini-tool-runs/${f.taskId}`, { headers: { Cookie: await cookie(userId) } });
}
/** Create one legal task without a planned F; action/label never authenticate this parent.
 * @throws {Error} When the fixture SQL fails.
 */
async function legacy(f: ExecutionFixture): Promise<string> {
  const id = randomUUID();
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params)
    VALUES (${id},${f.userId},${f.projectId},${f.plan.spaceId},'video','append','mini_tool','pending','legacy-fixture',${pg.json({})})`;
  return id;
}
/** A real POST admission and original start-row owner, not a hand-shaped accepted response.
 * @throws {Error} When the real admission or fixture setup fails.
 */
async function admitted(): Promise<ExecutionFixture> {
  const f = await seedStudioFixture(pg, "parent"); await seedDesignatedLot(pg, f, 1000);
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${f.projectId},${f.userId},'owner')`;
  const viewerId = randomUUID(); await pg`INSERT INTO users (id,email,email_verified) VALUES (${viewerId},${`${viewerId}@example.test`},true)`;
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${f.projectId},${viewerId},'viewer')`;
  const sourceId = randomUUID(); const sourceKey = `video/parent-source/${sourceId}.mp4`; const sourceURL = (await getStorageAdapter()).publicUrl(sourceKey);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceId},${f.studioId},${"a".repeat(64)},${sourceKey},${sourceURL},4096,'video/mp4','video','upload',${f.userId},960,540,5.055)`;
  const presented = await presentedSource("a".repeat(64), sourceKey, (key) => sourceURL.slice(0, sourceURL.length - sourceKey.length) + key);
  outside.snapshots.set(sourceKey, presented.snapshot); 
  // One segment over the fixture version's whole grid (presentation-fixtures.ts: 1011 frames).
  const body = { presentation_ref: presented.presentationRef, tool: "video.split", project_id: f.projectId, space_id: randomUUID(), run_id: randomUUID(),
    draft: { version: 1, draftId: randomUUID(), revision: randomUUID(), source: { nodeId: randomUUID(), canonicalURL: sourceURL, mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } }, inputs: [], params: { cuts: [] } },
    analysis_refs: [], outputs: [{ outputIndex: 0, nodeId: randomUUID(), recipe: { kind: "segment", range: { start: 0, end: 1011 } } }] } as MiniToolPlannedRequest;
  const response = await app.request("/api/v1/mini-tools", { method: "POST", headers: { Cookie: await cookie(f.userId), "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify(body) });
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ data: { task_id: body.run_id, status: "pending" } });
  const context = await miniToolExecutionService.startMiniToolExecution(body.run_id, body.run_id);
  const plan = context.execution;
  const record = await miniToolExecutionService.getMiniToolExecution(f.projectId, body.run_id, viewerId);
  const assetId = randomUUID(); const key = `video/parent-winner/${assetId}.webm`; const canonicalURL = (await getStorageAdapter()).publicUrl(key);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,generation_task_id,width,height,duration_seconds)
    VALUES (${assetId},${f.studioId},${"b".repeat(64)},${key},${canonicalURL},1588436,'video/webm','video','ai',${f.userId},${body.run_id},960,540,5.013)`;
  return { ...f, viewerId, taskId: body.run_id, plan, record, registered: { status: "registered", assetId, canonicalURL, contentHash: "b".repeat(64), kind: "video", mimeType: "video/webm", size: 1588436, width: 960, height: 540, duration: 5.013, cover: null } };
}
/** Persist controlled worker facts through original step/consumption/finish owners without provider IO.
 * @throws {Error} When a real persistence owner refuses these legal facts.
 */
async function completedPending(f: ExecutionFixture): Promise<void> {
  const [step] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "container_job", endpoint: "MiniToolContainerStd4", itemIndex: 0 }]);
  if (!step) throw new Error("Missing original controlled container step");
  // The run's one container job, its cost still pending on its report (frames-split §5.4).
  const inputId = randomUUID();
  const request = miniToolPlanJobRequestSchema.parse({ schemaVersion: 2, jobId: `${f.taskId}:batch:0:a1`, containerClass: "MiniToolContainerStd4", deadlineAt: 4070908800000,
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, inputs: [{ inputId, storageKey: "video/source.mp4" }],
    outputs: [{ outputIndex: 0, storageKey: `planned/${f.taskId}/0.mp4`, contentType: "video/mp4", recipe: { kind: "segment", inputId,
      grid: { fps: { numerator: 200, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 1011, realFrameCount: 1011 },
      source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frames: { start: 0, end: 1011 },
      target: { width: 960, height: 540, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" }, audio: true } }] });
  await openMiniToolPlanJob({ taskId: f.taskId, stepId: step.id, chunkIndex: 0, chargeTo: f.plan.chargeTo, request });
  await upstreamStepRepo.recordInline(step.id, { "miniToolAsset:0": f.registered.assetId }, 0);
  await miniToolExecutionService.finishMiniToolExecution(f.taskId, { planFingerprint: f.plan.planFingerprint, expectedVersion: 0, error: null,
    outputs: [{ ...f.plan.outputs[0]!, late: false, result: f.registered }] });
}

describe("node-task parent-run recovery through original persistent owners", () => {
  it("N01 preserves the distinct node-row and parent IDs through repository, service and real HTTP", async () => {
    const f = await admitted(); const [row] = await pg<{ id: string; task_id: string }[]>`SELECT id,task_id FROM node_tasks WHERE task_id=${f.taskId}`;
    expect(row?.task_id).toBe(f.taskId); expect(row?.id).not.toBe(f.taskId);
    expect(await nodeTaskRepo.findById(row!.id)).toMatchObject({ id: row!.id, taskId: f.taskId });
    expect(await nodeTaskService.listLive({ projectId: f.projectId, nodeId: f.plan.targetNodeIds[0]! })).toEqual([expect.objectContaining({ id: row!.id, taskId: f.taskId })]);
    const result = await list(f); expect(result.response.status).toBe(200); expect(result.rows).toEqual([expect.objectContaining({ id: row!.id, taskId: f.taskId, action: "mini_tool", label: "video.split" })]);
  });
  it("N02 emits explicit null for an upload without a parent", async () => {
    const f = await seedExecution(pg); const id = await open(f, undefined, "upload", null, "clip.webm"); const result = await list(f);
    expect(result.response.status).toBe(200); expect(result.rows).toEqual([expect.objectContaining({ id, taskId: null, action: "upload" })]);
  });
  it("N03 preserves actual legacy parent IDs without authenticating a planned F from the label", async () => {
    const f = await seedExecution(pg); const generateParent = await legacy(f); const toolParent = await legacy(f);
    const g = await open(f, undefined, "generate", generateParent, "legacy-video"); const t = await open(f, undefined, "mini_tool", toolParent);
    const result = await list(f); expect(result.response.status).toBe(200);
    expect(result.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: g, taskId: generateParent }), expect.objectContaining({ id: t, taskId: toolParent })]));
    expect((await app.request(`/api/v1/projects/${f.projectId}/mini-tool-runs/${toolParent}`, { headers: { Cookie: await cookie(f.viewerId) } })).status).toBe(404);
  });
  it("N04 respects the actual nullable FK after a parent is physically removed", async () => {
    const f = await seedExecution(pg); const old = await legacy(f); const id = await open(f, undefined, "generate", old);
    await pg`DELETE FROM tasks WHERE id=${old}`; expect((await list(f)).rows).toEqual([expect.objectContaining({ id, taskId: null })]);
  });
  it("N05 keeps every live row's own parent while preserving newest-first ordering", async () => {
    const f = await seedExecution(pg); const other = await legacy(f); const a = await open(f); const b = await open(f, undefined, "mini_tool", other); const c = await open(f);
    await nodeTaskService.settle({ taskId: a, outcome: "done" });
    await pg`UPDATE node_tasks SET started_at='2026-10-25T00:00:01Z' WHERE id=${a}`;
    await pg`UPDATE node_tasks SET started_at='2026-10-25T00:00:02Z' WHERE id=${b}`;
    await pg`UPDATE node_tasks SET started_at='2026-10-25T00:00:03Z' WHERE id=${c}`;
    const result = await list(f); expect(result.rows.map((r) => ({ id: r.id, taskId: r.taskId }))).toEqual([{ id: c, taskId: f.taskId }, { id: b, taskId: other }, { id: a, taskId: f.taskId }]);
  });
  it("N06 projects one SQL parent across two node rows without claiming a legal multi-output F", async () => {
    // This is the real node-row FK/query boundary only. The fixture F has one split slot.
    const f = await seedExecution(pg); const secondNode = randomUUID(); const a = await open(f); const b = await open(f, secondNode);
    expect((await list(f)).rows).toEqual([expect.objectContaining({ id: a, taskId: f.taskId })]);
    expect((await list(f, f.userId, secondNode)).rows).toEqual([expect.objectContaining({ id: b, taskId: f.taskId })]);
    const response = await parentGet(f); expect(response.status).toBe(200); const wire = await response.json() as { data: unknown };
    expect(miniToolExecutionRecordSchema.parse(wire.data).outputs).toEqual(f.record.outputs);
  });
  it("N07 clears only the settled row and retains the parent and history", async () => {
    const f = await seedExecution(pg); const id = await open(f); const remaining = await open(f);
    const history = await nodeHistoryService.recordGenerationFailure({ projectId: f.projectId, nodeId: f.plan.targetNodeIds[0]!, userId: f.userId, taskId: f.taskId, errorMessage: "fixture failure" });
    await nodeTaskService.settle({ taskId: id, outcome: "failed", nodeHistoryId: history.id, errorMessage: "fixture failure" });
    const response = await app.request(`/api/v1/canvas/node-tasks/${id}?project_id=${f.projectId}&space_id=${f.plan.spaceId}&node_id=${f.plan.targetNodeIds[0]}`, { method: "DELETE", headers: { Cookie: await cookie(f.userId) } });
    expect(response.status).toBe(200); expect((await list(f)).rows).toEqual([expect.objectContaining({ id: remaining, taskId: f.taskId })]);
    expect((await parentGet(f)).status).toBe(200); expect(await pg`SELECT id FROM node_history WHERE id=${history.id}`).toHaveLength(1);
  });
  it("N08 harvest expires the row while retaining its parent identity and original parent state", async () => {
    const f = await seedExecution(pg); const id = await open(f);
    await pg`UPDATE node_tasks SET started_at=now()-((budget_ms+1000)*interval '1 millisecond') WHERE id=${id}`;
    const result = await list(f); expect(result.response.status).toBe(200); expect(result.rows).toEqual([expect.objectContaining({ id, taskId: f.taskId, status: "expired" })]);
    expect((await executionSnapshot(pg, f)).status).toBe("pending");
  });
  it.each([false, true])("N09 current viewer/archived member reads the original run without actor authority (archived=%s)", async (archived) => {
    const f = await seedExecution(pg); const id = await open(f);
    if (archived) await pg`UPDATE projects SET archived_at=now(),archived_by_user_id=${f.userId} WHERE id=${f.projectId}`;
    const listed = await list(f, f.viewerId); expect(listed.response.status).toBe(200); expect(listed.rows).toEqual([expect.objectContaining({ id, taskId: f.taskId })]);
    expect((await parentGet(f)).status).toBe(200);
  });
  it.each(["unauthenticated", "nonmember", "wrong project"])("N10 refuses %s before harvesting another project's expired row", async (kind) => {
    const f = await seedExecution(pg); const outsider = await seedExecution(pg); const id = await open(f);
    await pg`UPDATE node_tasks SET started_at=now()-((budget_ms+1000)*interval '1 millisecond') WHERE id=${id}`;
    const read = await list(f, kind === "unauthenticated" ? null : outsider.userId, undefined, kind === "wrong project" ? outsider.projectId : f.projectId);
    expect(read.response.status).toBe(kind === "unauthenticated" ? 401 : kind === "wrong project" ? 200 : 404);
    if (kind === "wrong project") expect(read.rows).toEqual([]);
    const [row] = await pg`SELECT status FROM node_tasks WHERE id=${id}`; expect(row?.status).toBe("running");
    if (kind !== "unauthenticated") expect((await parentGet(f, outsider.userId, kind === "wrong project" ? outsider.projectId : f.projectId)).status).toBe(404);
  });
  it.each(["deleted", "membership removed"])("N11 retains the row while parent GET enforces %s", async (kind) => {
    const f = await seedExecution(pg); const id = await open(f);
    if (kind === "deleted") await pg`UPDATE tasks SET deleted_at=now() WHERE id=${f.taskId}`;
    else await pg`DELETE FROM project_members WHERE project_id=${f.projectId} AND user_id=${f.viewerId}`;
    expect((await list(f)).rows).toEqual([expect.objectContaining({ id, taskId: f.taskId })]); expect((await parentGet(f)).status).toBe(404);
  });
  it("N12 a fresh collaborator discovers the admitted parent through real rows and reads registered media while its bill is pending", async () => {
    const f = await admitted(); await completedPending(f); const listed = await list(f, f.viewerId);
    expect(listed.response.status).toBe(200); expect(listed.rows).toHaveLength(1); expect(listed.rows[0]).toMatchObject({ taskId: f.taskId });
    const response = await parentGet(f); expect(response.status).toBe(200); const body = await response.json() as { data: unknown }; const record = miniToolExecutionRecordSchema.parse(body.data);
    expect(record).toMatchObject({ runId: f.taskId, status: "completed", resultVersion: 1, billingState: "waiting", sourceBindings: [{ mediaInfo: { duration: 5.055 } }], outputs: [{ outputIndex: 0, nodeId: f.plan.targetNodeIds[0], result: { ...f.registered, duration: 5.013 } }] });
  });
  it("N13 repeated recovery GETs preserve SQL run/history and emit counts without a media result", async () => {
    const f = await admitted(); await completedPending(f); const before = await executionSnapshot(pg, f);
    const historyBefore = await pg`SELECT * FROM node_history WHERE task_id=${f.taskId}`;
    const redis = getStreamRedis(); const start = await redis.xrevrange(taskEventsStreamKey(), "+", "-", "COUNT", 1); const afterId = start[0]?.[0] ?? "0-0";
    for (let i = 0; i < 2; i++) { expect((await list(f, f.viewerId)).response.status).toBe(200); expect((await parentGet(f)).status).toBe(200); }
    expect(await executionSnapshot(pg, f)).toEqual(before); expect(await pg`SELECT * FROM node_history WHERE task_id=${f.taskId}`).toEqual(historyBefore);
    const emitted = await redis.xrange(taskEventsStreamKey(), `(${afterId}`, "+");
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const [, fields] of emitted) {
      const values = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2]!, fields[i * 2 + 1]!]));
      expect(values).toHaveProperty("payload");
      const event: unknown = JSON.parse(values.payload!); expect(event).toHaveProperty("type", "node-task-counts");
      expect(event).not.toHaveProperty("result"); expect(event).not.toHaveProperty("resultOrigin");
    }
  });
  it("N14 counts publication failure still returns the real parent-bearing row and logs the error", async () => {
    const f = await seedExecution(pg); const id = await open(f); const log = vi.spyOn(logger, "error"); const stream = vi.spyOn(getStreamRedis(), "xadd").mockRejectedValueOnce(new Error("fixture counts stream unavailable"));
    try { const result = await list(f); expect(result.response.status).toBe(200); expect(result.rows).toEqual([expect.objectContaining({ id, taskId: f.taskId })]); expect(log).toHaveBeenCalled(); }
    finally { stream.mockRestore(); log.mockRestore(); }
  });
});
