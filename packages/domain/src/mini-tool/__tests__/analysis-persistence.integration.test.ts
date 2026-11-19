// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import crypto from "node:crypto";
import fc from "fast-check";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { ConflictError, NotFoundError, createPgClient, db, getMiniToolsConfig, getNodeTaskConfig, getStorageAdapter, initCore } from "@breatic/core";
import { fingerprintMiniToolAnalysisInput, miniToolAnalysisRecordSchema, miniToolAnalysisRequestSchema, miniToolAnalysisResultSchema, miniToolConsumptionKey, projectMiniToolAnalysisInput, selectMiniToolAnalyses, type MiniToolAnalysisArtifact, type MiniToolAnalysisKind, type MiniToolAnalysisRecord, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import { miniToolSettlementSchema } from "@domain/mini-tool/consumption.types.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";
import { seedStudioFixture } from "../../../../server/src/__tests__/integration/studio-credit-fixtures.js";
import { presentedSource } from "../../../../server/src/__tests__/integration/presentation-fixtures.js";
import type * as shared from "@breatic/shared";

// S6e E4-2/E4-12 (inner#1306 §90): an analysis names its tool input and freezes the selected version's receipts; the
// ingest snapshot is faked and the stored ledger objects are served by URL, as for a fresh execution admission.
const outside = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), bodies: new Map<string, string>() }));
vi.mock("@breatic/shared", async (original) => ({
  ...await original<typeof shared>(),
  videoPresentationAtIngest: vi.fn(async (_url: string, _secret: string, input: { storageKey: string }): Promise<unknown> => {
    const snapshot = outside.snapshots.get(input.storageKey);
    if (!snapshot) throw new Error("Unseeded external presentation snapshot");
    return structuredClone(snapshot);
  }),
}));

type Status = "pending" | "running" | "completed" | "failed" | "cancelled";
type PeopleResult = Extract<MiniToolAnalysisResult, { kind: "people" }>;
interface Fixture {
  taskId: string; userId: string; nodeTaskId: string; stepId: string; consumptionKey: string;
  result: MiniToolAnalysisResult; initial: MiniToolAnalysisRecord;
}
interface TaskSnapshot {
  status: string; result: Record<string, unknown>; params: unknown; error_message: string | null;
  created_at: string; completed_at: string | null; updated_at: string;
  billed_at: string | null; billed_credits: string | null;
}
interface Snapshot {
  task: TaskSnapshot; step: unknown; node: unknown; holds: unknown[]; usage: number; ledger: number;
}
let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;
const T0 = "2026-10-24T09:03:03.100001Z";
const ERROR = { code: "fixture_analysis_failure", detail: "original failure" };

beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false" });
  pg = createPgClient(inject("DATABASE_URL"), { name: "analysis-persistence-fixtures", max: 4 });
  const storage = await getStorageAdapter();
  publicUrl = storage.publicUrl.bind(storage);
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const body = outside.bodies.get(input instanceof Request ? input.url : String(input));
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { headers: { "Content-Type": "application/json" } });
  }));
});
afterAll(async () => { vi.unstubAllGlobals(); await pg.end(); });

/** Register independent fixture truth for one internal artifact. */
async function artifact(studioId: string, userId: string, role: MiniToolAnalysisArtifact["role"]): Promise<MiniToolAnalysisArtifact> {
  const id = crypto.randomUUID(); const hash = crypto.randomBytes(32).toString("hex");
  const document = role === "rle"; const image = role === "thumbnail";
  const kind = document ? "document" : image ? "image" : "video";
  const mimeType = document ? "text/plain" : image ? "image/png" : "video/mp4";
  const key = `${kind}/analysis-fixture/${id}`; const url = publicUrl(key);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${id},${studioId},${hash},${key},${url},128,${mimeType},${kind},'upload',${userId},${document ? null : 80},${document ? null : 60},${kind === "video" ? 5 : null})`;
  return { role, assetId: id, canonicalURL: url, contentHash: hash, kind, mimeType, size: 128, frameMetadata: null };
}

/**
 * Seed a frozen task with registered references and independent execution facts.
 * @param open - Whether the task also holds a provider submit intent with no answer, so a terminal outcome leaves its set open.
 */
async function seed(kind: MiniToolAnalysisKind = "people", status: Status = "running", at = T0, open = false): Promise<Fixture> {
  const { userId, studioId, projectId } = await seedStudioFixture(pg, "analysis-persistence");
  await pg`INSERT INTO project_members (project_id,user_id,role) VALUES (${projectId},${userId},'owner')`;
  const taskId = crypto.randomUUID(); const spaceId = crypto.randomUUID(); const hostNodeId = crypto.randomUUID();
  const sourceAssetId = crypto.randomUUID(); const sourceHash = crypto.randomBytes(32).toString("hex");
  const sourceKey = `video/analysis-fixture/${sourceAssetId}.mp4`; const sourceURL = publicUrl(sourceKey);
  await pg`INSERT INTO studio_assets (id,studio_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source,produced_by_user_id,width,height,duration_seconds)
    VALUES (${sourceAssetId},${studioId},${sourceHash},${sourceKey},${sourceURL},4096,'video/mp4','video','upload',${userId},400,200,5)`;
  const binding = { assetId: sourceAssetId, contentHash: sourceHash, canonicalURL: sourceURL, kind: "video", mediaInfo: { width: 400, height: 200, duration: 5, mimeType: "video/mp4" } };
  const anchor = { frameIndex: 1 }; const range = { start: 0, end: 5 };
  const analysisInput = projectMiniToolAnalysisInput({ kind, source: { canonicalURL: sourceURL }, profile: getMiniToolsConfig().analyses[kind].profile,
    params: kind === "people" ? { anchor } : kind === "scene_cuts" ? { range } : { anchor, range, region: { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, points: [] }, trackingPrompt: "the selected person" },
  });
  const identity = { schemaVersion: 1, draftId: "20000000-0000-4000-8000-000000000001", revision: "30000000-0000-4000-8000-000000000001", analysisRunId: taskId, acceptedAt: at, kind, binding, analysisInput, inputFingerprint: await fingerprintMiniToolAnalysisInput(analysisInput) };
  const payload = kind === "people" ? { anchor, people: [{ personId: "person-1", faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, artifactRefs: [await artifact(studioId, userId, "thumbnail")] }] }
    : kind === "scene_cuts" ? { fps: { numerator: 4, denominator: 1 }, frameCount: 20, cuts: [{ frameIndex: 2, detectionScore: 85 }] }
      : { anchor, width: 400, height: 200, frameCount: 20, fps: { numerator: 4, denominator: 1 }, regionFingerprint: "d".repeat(64), artifactRefs: await Promise.all(["rle"].map((role) => artifact(studioId, userId, role as MiniToolAnalysisArtifact["role"]))) };
  const result = miniToolAnalysisResultSchema.parse({ ...identity, ...payload });
  const normalized = status === "cancelled" ? "failed" : status;
  const initial = miniToolAnalysisRecordSchema.parse({ ...identity, status: normalized, result: status === "completed" ? result : null, error: normalized === "failed" ? ERROR : null, usage: [{ marker: "original-usage" }], artifactUnavailable: false });
  const presentation = await presentedSource(sourceHash, sourceKey, publicUrl);
  outside.snapshots.set(sourceKey, presentation.snapshot);
  const frozen = { schemaVersion: 1, analysisRunId: taskId, projectId, spaceId, hostNodeId, draftId: identity.draftId, revision: identity.revision, kind,
    source: { nodeId: hostNodeId, canonicalURL: sourceURL, mediaInfo: binding.mediaInfo }, binding, analysisInput, inputFingerprint: identity.inputFingerprint,
    // The tool input, the selected version and the payer frozen with the analysis, as for an execution (frames-split §7.11, §5.5).
    presentationRef: presentation.presentationRef, presentations: { source: presentation.bundle }, versionIds: { source: presentation.versionId },
    chargeTo: kind === "people" ? "platform" as const : "user" as const };
  const params = { analysis: frozen, requestFingerprint: "e".repeat(64), sourceKey, credits: kind === "people" ? 0 : 1 };
  const stepId = crypto.randomUUID(); const nodeTaskId = crypto.randomUUID();
  const expenseIdentity = { kind: "container", containerClass: "std1", jobId: taskId, chunkIndex: 0 } as const;
  const key = await miniToolConsumptionKey({ taskId, stepId, identity: expenseIdentity });
  const fact = { schemaVersion: 1, consumptionKey: key, identity: expenseIdentity, state: "known", creditMultiplier: 1, chargeTo: kind === "people" ? "platform" : "user", costUsd: 0.0001, costSource: "computed", raw: { wallMs: 1000, cpuUsec: 1000 }, credits: null, containerPricing: { configVersion: "fixture", size: { vcpu: 0.5, memory_gib: 4, disk_gb: 8 }, prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 } } };
  const settlement = { version: 7, state: "waiting", pendingConsumptionKeys: [key], nextAttemptAt: T0, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: false };
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result,error_message,created_at,completed_at)
    VALUES (${taskId},${userId},${projectId},${spaceId},'mini_tool_analysis','append','mini_tool',${status},${pg.json(z.json().parse(params))},${pg.json({ analysis: initial, settlement, manifest: { outputs: [{ canonicalURL: "https://assets.test.invalid/preserved.mp4" }] }, preserved: { original: true } })},${normalized === "failed" ? ERROR.code : null},${at}::text::timestamptz,${status === "completed" || normalized === "failed" ? at : null}::text::timestamptz)`;
  await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output) VALUES (${stepId},${taskId},0,'container_job','analysis-fixture','done',${pg.json({ miniToolConsumption: fact, preservedOutput: true })})`;
  await pg`INSERT INTO node_tasks (id,project_id,space_id,node_id,kind,action,status,started_by_user_id,budget_ms,label,task_id)
    VALUES (${nodeTaskId},${projectId},${spaceId},${hostNodeId},'generation','mini_tool','running',${userId},${getNodeTaskConfig().default_budget_ms},'analysis',${taskId})`;
  if (open) {
    const intentStepId = crypto.randomUUID(); const fingerprint = "a".repeat(64);
    const intent = { schemaVersion: 1, scope: { taskId, stepId: intentStepId, kind: "generate", endpoint: "analysis-fixture-model", itemIndex: 0 }, deadlineAt: Date.parse("2099-01-01T00:00:00Z"),
      requestBody: {}, requestFingerprint: fingerprint, chargeTo: "user", creditMultiplier: 1, result: null, error: null, conflicts: [],
      attempts: [{ attemptId: crypto.randomUUID(), preparedAt: T0, requestFingerprint: fingerprint, resolution: { kind: "unresolved" } }] };
    await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,item_index,status,output) VALUES (${intentStepId},${taskId},1,'generate','analysis-fixture-model',0,'pending',${pg.json({ miniToolStep: intent })})`;
  }
  if (kind !== "people") await pg`INSERT INTO credit_holds (studio_id,actor_user_id,reference_id,amount,status,expires_at) VALUES (${studioId},${userId},${taskId},1,'held','2099-01-01T00:00:00Z')`;
  return { taskId, userId, nodeTaskId, stepId, consumptionKey: key, result, initial };
}

/**
 * Seed a task whose call set a terminal outcome cannot close: it also holds a provider submit intent with no answer.
 * @param kind - The analysis kind.
 * @param status - The task status.
 * @param at - The acceptance instant.
 * @returns The fixture.
 */
async function seedOpen(kind: MiniToolAnalysisKind = "people", status: Status = "running", at = T0): Promise<Fixture> {
  return seed(kind, status, at, true);
}

/** Observe SQL and execution facts through an independent PostgreSQL pool. */
async function snapshot(f: Fixture): Promise<Snapshot> {
  const [task] = await pg<TaskSnapshot[]>`SELECT status,result,params,error_message,created_at::text,completed_at::text,updated_at::text,billed_at::text,billed_credits::text FROM tasks WHERE id=${f.taskId}`;
  const [step] = await pg<{ value: unknown }[]>`SELECT to_jsonb(s) AS value FROM task_upstream_steps s WHERE id=${f.stepId}`;
  const [node] = await pg<{ value: unknown }[]>`SELECT to_jsonb(n) AS value FROM node_tasks n WHERE id=${f.nodeTaskId}`;
  const holds = await pg`SELECT status,amount::text,expires_at::text,released_at::text FROM credit_holds WHERE reference_id=${f.taskId}`;
  const [usage] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key=${f.consumptionKey}`;
  const [ledger] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM credit_ledger WHERE reference_id=${f.taskId}`;
  if (!task || !step || !node || !usage || !ledger) throw new Error("Incomplete analysis fixture");
  return { task, step: step.value, node: node.value, holds: [...holds], usage: usage.count, ledger: ledger.count };
}

/** Remove only the analysis key when comparing sibling result ownership. */
function siblings(result: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...result }; delete copy.analysis; return copy;
}

/** Check that metadata preserved current immutable and financial facts. */
function assertPreserved(before: Snapshot, after: Snapshot): void {
  expect(after.task.params).toEqual(before.task.params);
  expect(after.task.created_at).toBe(before.task.created_at);
  expect(after.task.billed_at).toBe(before.task.billed_at);
  expect(after.task.billed_credits).toBe(before.task.billed_credits);
  expect(siblings(after.task.result)).toEqual(siblings(before.task.result));
  expect({ step: after.step, node: after.node, holds: after.holds, usage: after.usage, ledger: after.ledger }).toEqual({ step: before.step, node: before.node, holds: before.holds, usage: before.usage, ledger: before.ledger });
}

/** Submit the independent result through the worker's entry without generating a new identity or closing the call set. */
async function record(f: Fixture, result: unknown = f.result, taskId: string = f.taskId): Promise<MiniToolAnalysisRecord> {
  return (await domain.miniToolAnalysisService.finishMiniToolAnalysis(taskId, { kind: "result", result })).record;
}

/** Submit one known application failure through the worker's entry. */
async function fail(f: Fixture, error: unknown = ERROR): Promise<MiniToolAnalysisRecord> {
  return (await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "error", error })).record;
}

/** Select a fresh people payload for the frozen-field mutation matrix. */
function people(f: Fixture): PeopleResult {
  if (f.result.kind !== "people") throw new Error("Expected a people fixture");
  return structuredClone(f.result);
}

describe("accepted analysis execution entry", () => {
  it.each(["people", "scene_cuts", "tracked_mask"] as const)("starts the original pending %s analysis with its SQL identity", async (kind) => {
    const f = await seed(kind, "pending", "2026-10-25T01:02:03.123456Z");
    const before = await snapshot(f);
    const execution = await domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-original");
    expect(execution.record).toEqual({ ...f.initial, status: "running" });
    expect(execution.record.acceptedAt).toBe("2026-10-25T01:02:03.123456Z");
    expect(execution.params).toEqual(before.task.params);
    const frozen = domain.miniToolAnalysisService.miniToolFrozenAnalysisSchema.parse(execution.params.analysis);
    expect(execution.context).toEqual({ taskId: f.taskId, userId: f.userId, projectId: frozen.projectId, spaceId: frozen.spaceId, hostNodeId: frozen.hostNodeId });
    const after = await snapshot(f);
    expect(after.task.status).toBe("running"); expect(after.task.completed_at).toBeNull(); assertPreserved(before, after);
    const [started] = await pg`SELECT arq_job_id, started_at::text FROM tasks WHERE id=${f.taskId}`;
    expect(started?.arq_job_id).toBe("analysis-job-original"); expect(started?.started_at).toEqual(expect.any(String));
  });

  it("retains the first start and all accepted dependencies across a repeated pickup", async () => {
    const f = await seed("scene_cuts", "running");
    await pg`UPDATE tasks SET arq_job_id='analysis-job-original',started_at='2026-10-24T09:03:03.100001Z'::timestamptz WHERE id=${f.taskId}`;
    const before = await snapshot(f);
    const first = await domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-original");
    const replay = await domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-original");
    expect(replay).toEqual(first); expect(first.params).toEqual(before.task.params); expect(first.record).toEqual(f.initial);
    const [started] = await pg`SELECT to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_start FROM tasks WHERE id=${f.taskId}`;
    expect(started?.first_start).toBe("2026-10-24T09:03:03.100001Z"); assertPreserved(before, await snapshot(f));
  });

  it.each(["completed", "failed", "cancelled"] as const)("reads the original %s outcome with all execution facts preserved", async (status) => {
    const f = await seed("scene_cuts", status); const before = await snapshot(f);
    const execution = await domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-replay");
    expect(execution.record).toEqual(f.initial); expect(execution.params).toEqual(before.task.params);
    expect(await snapshot(f)).toEqual(before);
    const [started] = await pg`SELECT arq_job_id, started_at FROM tasks WHERE id=${f.taskId}`;
    expect(started).toEqual({ arq_job_id: null, started_at: null });
  });

  it("continues an accepted analysis hidden from user history using the original source", async () => {
    const f = await seed("people", "pending");
    await pg`UPDATE tasks SET deleted_at='2026-10-25T01:02:03.123456Z'::timestamptz WHERE id=${f.taskId}`;
    const before = await snapshot(f);
    const execution = await domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-hidden");
    expect(execution.record).toEqual({ ...f.initial, status: "running" }); expect(execution.params).toEqual(before.task.params);
    const [hidden] = await pg`SELECT deleted_at::text AS hidden_at FROM tasks WHERE id=${f.taskId}`;
    expect(hidden?.hidden_at).toContain("2026-10-25"); assertPreserved(before, await snapshot(f));
  });

  it.each(["source", "task_type", "source_key", "run", "project", "space"] as const)("rejects the invalid persisted %s before changing execution state", async (field) => {
    const f = await seed("people", "pending");
    if (field === "source") await pg`UPDATE tasks SET source='task' WHERE id=${f.taskId}`;
    else if (field === "task_type") await pg`UPDATE tasks SET task_type='image' WHERE id=${f.taskId}`;
    else if (field === "source_key") await pg`UPDATE tasks SET params=params-'sourceKey' WHERE id=${f.taskId}`;
    else {
      const key = field === "run" ? "analysisRunId" : field === "project" ? "projectId" : "spaceId";
      await pg`UPDATE tasks SET params=jsonb_set(params,ARRAY['analysis',${key}],${pg.json(crypto.randomUUID())}) WHERE id=${f.taskId}`;
    }
    const before = await snapshot(f);
    await expect(domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-invalid")).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
    const [started] = await pg`SELECT arq_job_id, started_at FROM tasks WHERE id=${f.taskId}`;
    expect(started).toEqual({ arq_job_id: null, started_at: null });
  });

  it("rejects an absent task and an empty queue identity", async () => {
    const f = await seed("people", "pending"); const before = await snapshot(f);
    await expect(domain.miniToolAnalysisService.startMiniToolAnalysisExecution(crypto.randomUUID(), "analysis-job-absent")).rejects.toThrow();
    await expect(domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "")).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it("rolls back the execution start when its SQL write fails", async () => {
    const f = await seed("scene_cuts", "pending"); const before = await snapshot(f);
    await pg.unsafe(`CREATE FUNCTION reject_analysis_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.status='running' THEN RAISE EXCEPTION 'fixture_analysis_start_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_analysis_start BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_analysis_start()");
    try {
      await expect(domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-rollback")).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_analysis_start_failed") } });
      expect(await snapshot(f)).toEqual(before);
    } finally { await pg.unsafe("DROP TRIGGER reject_analysis_start ON tasks"); await pg.unsafe("DROP FUNCTION reject_analysis_start()"); }
  });

  it("observes a competing completed outcome after waiting for the original task lock", async () => {
    const f = await seed("scene_cuts", "pending"); const completed = { ...f.initial, status: "completed", result: f.result };
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const ready = new Promise<void>((resolve) => { entered = resolve; });
    const owner = pg.begin(async (tx) => {
      await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; entered(); await gate;
      await tx`UPDATE tasks SET status='completed',result=result || ${tx.json({ analysis: completed })},completed_at=clock_timestamp() WHERE id=${f.taskId}`;
    });
    await ready;
    const pickup = domain.miniToolAnalysisService.startMiniToolAnalysisExecution(f.taskId, "analysis-job-old-pickup");
    const observed = pickup.catch(() => undefined);
    try { await Promise.race([waitUntilBlockedOn(pg, ["tasks", "for update"], 1), pickup.then(() => { throw new Error("Execution entry bypassed the task lock"); })]); }
    finally { release(); await owner; await observed; }
    expect((await pickup).record).toEqual(completed);
    const [started] = await pg`SELECT status, arq_job_id, started_at FROM tasks WHERE id=${f.taskId}`;
    expect(started).toEqual({ status: "completed", arq_job_id: null, started_at: null });
  });
});

describe("atomic analysis computation completion", () => {
  it.each(["people", "scene_cuts", "tracked_mask"] as const)("commits %s metadata and proven identities together", async (kind) => {
    const f = await seed(kind); const before = await snapshot(f);
    const params = before.task.params as { analysis: { projectId: string; spaceId: string; hostNodeId: string } };
    const expected = { ...f.initial, status: "completed", result: f.result };
    expect(await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "result", result: f.result })).toEqual({
      record: expected,
      context: { taskId: f.taskId, userId: f.userId, projectId: params.analysis.projectId, spaceId: params.analysis.spaceId, hostNodeId: params.analysis.hostNodeId },
    });
    const after = await snapshot(f);
    expect(after.task.status).toBe("completed");
    expect(after.task.result.analysis).toEqual(expected);
    expect(after.task.result.settlement).toMatchObject({ state: "waiting", version: 8, consumptionSetComplete: true, pendingConsumptionKeys: [f.consumptionKey] });
    const preserved = { ...after, task: { ...after.task, result: { ...after.task.result, settlement: before.task.result.settlement } } };
    assertPreserved(before, preserved);
  });

  it.each(["pending", "running"] as const)("atomically closes a failed computation from %s while retaining its hold", async (status) => {
    const f = await seed("scene_cuts", status); const before = await snapshot(f);
    const finished = await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "error", error: ERROR });
    expect(finished.record).toEqual({ ...f.initial, status: "failed", error: ERROR });
    const after = await snapshot(f);
    expect(after.task.status).toBe("failed");
    expect(after.task.result.settlement).toMatchObject({ version: 8, consumptionSetComplete: true, pendingConsumptionKeys: [f.consumptionKey] });
    expect({ holds: after.holds, usage: after.usage, ledger: after.ledger, step: after.step }).toEqual({ holds: before.holds, usage: 0, ledger: 0, step: before.step });
    expect(after.task.billed_at).toBeNull();
  });

  it.each(["result", "error"] as const)("keeps the set open after a %s outcome while a submit attempt is unresolved", async (kind) => {
    const f = await seedOpen("scene_cuts"); const before = await snapshot(f);
    const completion = kind === "result" ? { kind, result: f.result } : { kind, error: ERROR };
    const finished = await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, completion);
    expect(finished.record.status).toBe(kind === "result" ? "completed" : "failed");
    const after = await snapshot(f);
    expect(after.task.result.settlement).toEqual(before.task.result.settlement);
    assertPreserved(before, after);
  });

  it.each(["result", "error"] as const)("closes a set with no unresolved attempt after a %s outcome (execution design §6.12)", async (kind) => {
    const f = await seed("scene_cuts"); const before = await snapshot(f);
    const completion = kind === "result" ? { kind, result: f.result } : { kind, error: ERROR };
    await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, completion);
    const after = await snapshot(f);
    expect(after.task.result.settlement).toMatchObject({ version: 8, consumptionSetComplete: true, pendingConsumptionKeys: [f.consumptionKey] });
    expect({ holds: after.holds, usage: after.usage, ledger: after.ledger, step: after.step }).toEqual({ holds: before.holds, usage: 0, ledger: 0, step: before.step });
  });

  it.each(["completed", "failed"] as const)("preserves the existing %s outcome while closing its proven identities", async (status) => {
    const f = await seed("scene_cuts", status); const before = await snapshot(f);
    const finished = await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "error", error: { code: "later_failure" } });
    expect(finished.record).toEqual(f.initial);
    const after = await snapshot(f);
    expect(after.task.status).toBe(status);
    expect(after.task.error_message).toBe(before.task.error_message);
    expect(after.task.completed_at).toBe(before.task.completed_at);
    expect(after.task.result.settlement).toMatchObject({ consumptionSetComplete: true, version: 8 });
    expect(after.holds).toEqual(before.holds);
  });

  it("retains a matching late result on a failed run and closes the original identities", async () => {
    const f = await seed("scene_cuts", "failed"); const before = await snapshot(f);
    const finished = await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "result", result: f.result });
    expect(finished.record).toEqual({ ...f.initial, result: f.result });
    const after = await snapshot(f);
    expect(after.task.status).toBe("failed"); expect(after.task.error_message).toBe(before.task.error_message);
    expect(after.task.result.settlement).toMatchObject({ consumptionSetComplete: true });
  });

  it("keeps an active expense claim when a computation closes its identities", async () => {
    const f = await seed("scene_cuts");
    const claim = { version: 7, state: "checking", pendingConsumptionKeys: [f.consumptionKey], nextAttemptAt: null,
      leaseToken: crypto.randomUUID(), leaseUntil: "2099-01-01T00:00:00.000000Z", lastError: null, consumptionSetComplete: false };
    await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement}',${pg.json(claim)}) WHERE id=${f.taskId}`;
    await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "result", result: f.result });
    expect((await snapshot(f)).task.result.settlement).toEqual({ ...claim, consumptionSetComplete: true });
  });

  it("keeps a previously closed set on a terminal replay", async () => {
    const f = await seed("scene_cuts", "completed");
    await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement,consumptionSetComplete}','true'::jsonb) WHERE id=${f.taskId}`;
    const before = await snapshot(f);
    const finished = await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "error", error: ERROR });
    expect(finished.record).toEqual(f.initial); expect(await snapshot(f)).toEqual(before);
  });

  it.each(["result", "error"] as const)("rolls back the %s outcome when closing the call set fails", async (kind) => {
    const f = await seed("scene_cuts"); const before = await snapshot(f);
    await pg.unsafe(`CREATE OR REPLACE FUNCTION reject_analysis_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result#>>'{settlement,consumptionSetComplete}'='true' THEN RAISE EXCEPTION 'fixture_call_set_close_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_analysis_completion BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_analysis_completion()");
    try {
      const completion = kind === "result" ? { kind, result: f.result } : { kind, error: ERROR };
      const error: unknown = await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, completion).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ cause: { message: expect.stringContaining("fixture_call_set_close_failed") } });
      expect(await snapshot(f)).toEqual(before);
    } finally {
      await pg.unsafe("DROP TRIGGER reject_analysis_completion ON tasks");
      await pg.unsafe("DROP FUNCTION reject_analysis_completion()");
    }
  });

  it("keeps all original facts when the result conflicts with its accepted identity", async () => {
    const f = await seed(); const before = await snapshot(f);
    await expect(domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, {
      kind: "result", result: { ...f.result, acceptedAt: "2026-10-23T01:02:03.123457Z" },
    })).rejects.toBeInstanceOf(ConflictError);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["result", "error"] as const)("rejects a foreign task source before its %s transition", async (kind) => {
    const f = await seed("scene_cuts");
    await pg`UPDATE tasks SET source='task' WHERE id=${f.taskId}`;
    const before = await snapshot(f);
    const completion = kind === "result" ? { kind, result: f.result } : { kind, error: ERROR };
    await expect(domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, completion)).rejects.toBeInstanceOf(Error);
    expect(await snapshot(f)).toEqual(before);
  });

  it("reads current state after waiting for a competing terminal writer", async () => {
    const f = await seed("scene_cuts");
    const committed = { ...f.initial, status: "completed", result: f.result };
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { locked = resolve; });
    const owner = pg.begin(async (tx) => {
      await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; locked(); await gate;
      await tx`UPDATE tasks SET status='completed',result=result || ${tx.json({ analysis: committed })},completed_at=clock_timestamp() WHERE id=${f.taskId}`;
    });
    await entered;
    const failure = domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "error", error: ERROR });
    const observed = failure.catch(() => undefined);
    try {
      await Promise.race([waitUntilBlockedOn(pg, ["tasks", "for update"], 1), failure.then(() => { throw new Error("Completion bypassed the task lock"); })]);
    } finally { release(); await owner; await observed; }
    const finished = await failure;
    expect(finished.record).toEqual(committed);
    expect((await snapshot(f)).task.result.settlement).toMatchObject({ consumptionSetComplete: true });
  });

  it("keeps the first terminal outcome across generated completion replays", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("result", "error"), { minLength: 1, maxLength: 5 }), async (events) => {
      const f = await seed("scene_cuts");
      for (const kind of events) {
        const completion = kind === "result" ? { kind, result: f.result } : { kind, error: ERROR };
        await domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, completion);
      }
      const after = await snapshot(f);
      expect(after.task.status).toBe(events[0] === "result" ? "completed" : "failed");
      expect(after.task.result.settlement).toMatchObject({ consumptionSetComplete: true, version: 8 });
      expect(after.task.billed_at).toBeNull(); expect(after.usage).toBe(0); expect(after.ledger).toBe(0);
    }), { numRuns: 6 });
  });
});

describe("persistent analysis results", () => {
  it.each(["people", "scene_cuts", "tracked_mask"] as const)("commits the complete %s result and preserves execution facts", async (kind) => {
    const f = await seedOpen(kind); const before = await snapshot(f);
    const expected = { ...f.initial, status: "completed", result: f.result };
    expect(await record(f)).toEqual(expected);
    const after = await snapshot(f);
    expect(after.task.status).toBe("completed"); expect(after.task.result.analysis).toEqual(expected);
    assertPreserved(before, after);
    expect(await domain.miniToolAnalysisService.get(f.taskId, f.userId)).toEqual(expected);
  });

  it.each(["pending", "running"] as const)("completes a task from %s", async (status) => {
    const f = await seedOpen("people", status);
    expect(await record(f)).toEqual({ ...f.initial, status: "completed", result: f.result });
  });

  it.each(["pending", "running"] as const)("stores the original failure from %s", async (status) => {
    const f = await seedOpen("scene_cuts", status); const before = await snapshot(f);
    expect(await fail(f)).toEqual({ ...f.initial, status: "failed", error: ERROR });
    const after = await snapshot(f); expect(after.task.status).toBe("failed"); assertPreserved(before, after);
  });

  it("keeps committed people identities and all SQL fields on a replay", async () => {
    const f = await seedOpen(); const committed = await record(f); const before = await snapshot(f);
    const incoming = people(f);
    incoming.analysisInput.profile.params = Object.fromEntries(Object.entries(incoming.analysisInput.profile.params).reverse());
    expect(await record(f, incoming)).toEqual(committed);
    expect(await snapshot(f)).toEqual(before);
    expect(await fail(f, { code: "late_deadline" })).toEqual(committed);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["failed", "cancelled"] as const)("preserves %s and its error when a matching result arrives late", async (status) => {
    const f = await seedOpen("people", status); const before = await snapshot(f);
    const expected = { ...f.initial, result: f.result };
    expect(await record(f)).toEqual(expected);
    const after = await snapshot(f); expect(after.task.status).toBe(status); expect(after.task.completed_at).toBe(before.task.completed_at); assertPreserved(before, after);
    expect(await fail(f, { code: "later_failure" })).toEqual(expected);
    expect(await record(f)).toEqual(expected);
    expect(await snapshot(f)).toEqual(after);
    expect(selectMiniToolAnalyses([expected], { draftId: expected.draftId, kind: expected.kind, inputFingerprint: expected.inputFingerprint }).latestSuccessful).toBeNull();
  });

  it.each(["people", "scene_cuts"] as const)("accepts empty %s results as complete analysis", async (kind) => {
    const f = await seedOpen(kind); const result = f.result.kind === "people" ? { ...f.result, people: [] } : { ...f.result, cuts: [] };
    expect(await record(f, result)).toEqual({ ...f.initial, status: "completed", result });
  });

  it("keeps two distinct SQL instants within the same JavaScript millisecond", async () => {
    for (const at of [T0, "2026-10-24T09:03:03.100002Z"]) {
      const f = await seedOpen("people", "running", at);
      expect((await record(f)).acceptedAt).toBe(at);
      expect((await domain.miniToolAnalysisService.get(f.taskId, f.userId)).acceptedAt).toBe(at);
    }
  });

  const identityChanges: { field: string; change: (result: PeopleResult) => PeopleResult; rehash?: boolean }[] = [
    { field: "draftId", change: (r) => ({ ...r, draftId: crypto.randomUUID() }) },
    { field: "revision", change: (r) => ({ ...r, revision: crypto.randomUUID() }) },
    { field: "analysisRunId", change: (r) => ({ ...r, analysisRunId: crypto.randomUUID() }) },
    { field: "acceptedAt", change: (r) => ({ ...r, acceptedAt: "2026-10-24T09:03:03.100002Z" }) },
    { field: "binding assetId", change: (r) => ({ ...r, binding: { ...r.binding, assetId: crypto.randomUUID() } }) },
    { field: "binding contentHash", change: (r) => ({ ...r, binding: { ...r.binding, contentHash: "f".repeat(64) } }) },
    { field: "binding geometry", change: (r) => ({ ...r, binding: { ...r.binding, mediaInfo: { ...r.binding.mediaInfo, width: 401 } } }) },
    { field: "source URL", rehash: true, change: (r) => ({ ...r, binding: { ...r.binding, canonicalURL: "https://assets.test.invalid/other.mp4" }, analysisInput: { ...r.analysisInput, sourceURL: "https://assets.test.invalid/other.mp4" } }) },
    { field: "profile id", rehash: true, change: (r) => ({ ...r, analysisInput: { ...r.analysisInput, profile: { ...r.analysisInput.profile, id: "other-detector" } } }) },
    { field: "profile version", rehash: true, change: (r) => ({ ...r, analysisInput: { ...r.analysisInput, profile: { ...r.analysisInput.profile, version: "other-version" } } }) },
    { field: "weights", rehash: true, change: (r) => ({ ...r, analysisInput: { ...r.analysisInput, profile: { ...r.analysisInput.profile, weightsHash: "e".repeat(64) } } }) },
    { field: "profile params", rehash: true, change: (r) => ({ ...r, analysisInput: { ...r.analysisInput, profile: { ...r.analysisInput.profile, params: { ...r.analysisInput.profile.params, changed: true } } } }) },
    { field: "anchor", rehash: true, change: (r) => ({ ...r, anchor: { frameIndex: 2 }, analysisInput: { ...r.analysisInput, anchor: { frameIndex: 2 } } }) },
    { field: "fingerprint", change: (r) => ({ ...r, inputFingerprint: "f".repeat(64) }) },
  ];
  it.each(identityChanges)("rejects frozen $field changes without a partial write", async ({ change, rehash }) => {
    const f = await seedOpen(); const before = await snapshot(f); const incoming = change(people(f));
    if (rehash) incoming.inputFingerprint = await fingerprintMiniToolAnalysisInput(incoming.analysisInput);
    await expect(record(f, incoming)).rejects.toBeInstanceOf(ConflictError);
    expect(await snapshot(f)).toEqual(before);
  });

  it("rejects a different valid analysis kind for the original task", async () => {
    const f = await seedOpen(); const before = await snapshot(f);
    const input = projectMiniToolAnalysisInput({ kind: "scene_cuts", source: { canonicalURL: f.result.binding.canonicalURL }, profile: getMiniToolsConfig().analyses.scene_cuts.profile, params: { range: { start: 0, end: 5 } } });
    const raw: Record<string, unknown> = { ...f.result, kind: "scene_cuts", analysisInput: input, inputFingerprint: await fingerprintMiniToolAnalysisInput(input), fps: { numerator: 4, denominator: 1 }, frameCount: 20, cuts: [] };
    delete raw.people; delete raw.anchor;
    const incoming = miniToolAnalysisResultSchema.parse(raw);
    await expect(record(f, incoming)).rejects.toBeInstanceOf(ConflictError); expect(await snapshot(f)).toEqual(before);
  });

  it.each(["people", "scene_cuts", "tracked_mask"] as const)("applies the complete typed %s schema at the write boundary", async (kind) => {
    const f = await seedOpen(kind); const before = await snapshot(f);
    const invalid = f.result.kind === "people" ? { ...f.result, people: [{ ...f.result.people[0]!, faceBox: { x: 0.9, y: 0, width: 0.2, height: 0.3 } }] }
      : f.result.kind === "scene_cuts" ? { ...f.result, cuts: [{ frameIndex: 20, detectionScore: 85 }] }
        : { ...f.result, artifactRefs: [] };
    await expect(record(f, invalid)).rejects.toBeInstanceOf(z.ZodError); expect(await snapshot(f)).toEqual(before);
  });

  it("rejects an unsupported result schema version", async () => {
    const f = await seedOpen(); const before = await snapshot(f);
    await expect(record(f, { ...f.result, schemaVersion: 2 })).rejects.toBeInstanceOf(z.ZodError);
    expect(await snapshot(f)).toEqual(before);
  });

  it("checks the frozen input even when the callback repeats the accepted fingerprint", async () => {
    const f = await seedOpen(); const before = await snapshot(f); const incoming = people(f);
    incoming.analysisInput.profile.version = "changed-with-original-fingerprint";
    await expect(record(f, incoming)).rejects.toBeInstanceOf(ConflictError);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["range", "region", "points", "trackingPrompt"] as const)("checks frozen tracking %s independently of its declared fingerprint", async (field) => {
    const f = await seedOpen("tracked_mask"); const before = await snapshot(f); const incoming = structuredClone(f.result);
    if (incoming.analysisInput.kind !== "tracked_mask") throw new Error("Expected tracking input");
    if (field === "range") incoming.analysisInput.range = { start: 1, end: 4 };
    if (field === "region") incoming.analysisInput.region.box = { x: 0.2, y: 0.1, width: 0.2, height: 0.3 };
    if (field === "points") incoming.analysisInput.region.points = [{ x: 0.2, y: 0.2, label: "positive" }];
    if (field === "trackingPrompt") incoming.analysisInput.trackingPrompt = "another subject";
    await expect(record(f, incoming)).rejects.toBeInstanceOf(ConflictError);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each([{ label: "null", value: null }, { label: "nonfinite JSON", value: { cost: NaN } }, { label: "missing", value: undefined }])("refuses a $label failure without changing task state", async ({ value }) => {
    const f = await seedOpen(); const before = await snapshot(f);
    await expect(domain.miniToolAnalysisService.finishMiniToolAnalysis(f.taskId, { kind: "error", error: value })).rejects.toBeInstanceOf(z.ZodError);
    expect(await snapshot(f)).toEqual(before);
  });

  it("rejects a conflicting replacement for a committed person identity", async () => {
    const f = await seedOpen(); await record(f); const before = await snapshot(f); const incoming = people(f);
    incoming.people[0]!.personId = "person-replacement";
    await expect(record(f, incoming)).rejects.toBeInstanceOf(ConflictError); expect(await snapshot(f)).toEqual(before);
  });

  it("keeps the current sibling settlement in both writer orders", async () => {
    const f = await seedOpen();
    await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement,version}','8'::jsonb) WHERE id=${f.taskId}`;
    const before = await snapshot(f); const committed = await record(f); assertPreserved(before, await snapshot(f));
    await db.transaction(async (tx) => {
      const task = await domain.taskRepo.lockMiniToolConsumptionTask(f.taskId, tx);
      const period = miniToolSettlementSchema.parse(task!.result.settlement);
      await domain.taskRepo.storeMiniToolSettlement(f.taskId, { ...period, version: 9 }, tx);
    });
    const after = await snapshot(f); expect(after.task.result.analysis).toEqual(committed);
    expect(after.task.result.settlement).toEqual({ ...(before.task.result.settlement as Record<string, unknown>), version: 9 });
  });

  it("rejects a missing task and a non-analysis task", async () => {
    const f = await seedOpen();
    await expect(record(f, f.result, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await pg`UPDATE tasks SET task_type='video' WHERE id=${f.taskId}`;
    const before = await snapshot(f); await expect(record(f)).rejects.toBeInstanceOf(NotFoundError); expect(await snapshot(f)).toEqual(before);
  });

  it.each(["people", "scene_cuts"] as const)("preserves completed %s work when admission receives a queue error", async (kind) => {
    const f = await seedOpen(kind); const before = await snapshot(f);
    const params = before.task.params as Record<string, unknown>;
    const frozen = domain.miniToolAnalysisService.miniToolFrozenAnalysisSchema.parse(params.analysis);
    const body = miniToolAnalysisRequestSchema.parse({
      analysisRunId: crypto.randomUUID(), projectId: frozen.projectId, spaceId: frozen.spaceId,
      hostNodeId: frozen.hostNodeId, draftId: frozen.draftId, revision: frozen.revision, kind, source: frozen.source,
      presentationRef: (params.analysis as { presentationRef: unknown }).presentationRef,
      params: kind === "people" && frozen.analysisInput.kind === "people" ? { anchor: frozen.analysisInput.anchor }
        : { range: { start: 0, end: 5 } },
    });
    let committed!: MiniToolAnalysisRecord;
    await expect(domain.miniToolAnalysisService.accept(body, f.userId, async (accepted) => {
      if (kind === "scene_cuts") await pg`INSERT INTO credit_holds (studio_id,actor_user_id,reference_id,amount,status,expires_at)
        SELECT studio_id,${f.userId},${body.analysisRunId},1,'held','2099-01-01T00:00:00Z' FROM projects WHERE id=${body.projectId}`;
      const identity = accepted.record;
      committed = await record(f, {
        ...f.result, schemaVersion: identity.schemaVersion, draftId: identity.draftId, revision: identity.revision,
        analysisRunId: identity.analysisRunId, acceptedAt: identity.acceptedAt, kind: identity.kind,
        binding: identity.binding, analysisInput: identity.analysisInput, inputFingerprint: identity.inputFingerprint,
      }, body.analysisRunId);
      throw new Error("fixture_queue_acknowledgement_failed");
    })).rejects.toThrow("fixture_queue_acknowledgement_failed");
    expect(await domain.miniToolAnalysisService.get(body.analysisRunId, f.userId)).toEqual(committed);
    const [task] = await pg<{ status: string }[]>`SELECT status FROM tasks WHERE id=${body.analysisRunId}`;
    expect(task).toEqual({ status: "completed" });
    if (kind === "scene_cuts") {
      const [hold] = await pg<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${body.analysisRunId}`;
      expect(hold).toEqual({ status: "held" });
    }
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["result", "error"] as const)("rolls back every task field when its %s UPDATE fails", async (event) => {
    const f = await seedOpen(); const before = await snapshot(f);
    await pg.unsafe(`CREATE OR REPLACE FUNCTION reject_analysis_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid THEN RAISE EXCEPTION 'fixture_analysis_update_failure'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_analysis_metadata BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_analysis_metadata()");
    try {
      const error: unknown = await (event === "result" ? record(f) : fail(f)).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ cause: { message: expect.stringContaining("fixture_analysis_update_failure") } });
      expect(await snapshot(f)).toEqual(before);
    } finally {
      await pg.unsafe("DROP TRIGGER reject_analysis_metadata ON tasks");
      await pg.unsafe("DROP FUNCTION reject_analysis_metadata()");
    }
  });

  it.each(["tasks", "credit_holds", "task_commit"] as const)("rolls back an unused admission's metadata and hold when %s rejects its UPDATE", async (failurePoint) => {
    const f = await seedOpen("scene_cuts", "pending");
    await pg`DELETE FROM task_upstream_steps WHERE id=${f.stepId}`;
    await pg`UPDATE tasks SET result=result-'settlement' WHERE id=${f.taskId}`;
    const [before] = await pg<{ status: string; result: unknown }[]>`SELECT status,result FROM tasks WHERE id=${f.taskId}`;
    const [holdBefore] = await pg<{ value: unknown }[]>`SELECT to_jsonb(h) AS value FROM credit_holds h WHERE reference_id=${f.taskId}`;
    const table = failurePoint === "credit_holds" ? "credit_holds" : "tasks";
    const condition = table === "tasks" ? `NEW.id='${f.taskId}'::uuid` : `NEW.reference_id='${f.taskId}'::text`;
    await pg.unsafe(`CREATE OR REPLACE FUNCTION reject_analysis_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'fixture_admission_update_failure'; END IF; RETURN NEW; END $$`);
    const trigger = failurePoint === "task_commit" ? "CREATE CONSTRAINT TRIGGER reject_analysis_admission AFTER UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED"
      : `CREATE TRIGGER reject_analysis_admission BEFORE UPDATE ON ${table}`;
    await pg.unsafe(`${trigger} FOR EACH ROW EXECUTE FUNCTION reject_analysis_admission()`);
    try {
      const error: unknown = await domain.miniToolAnalysisService.failMiniToolAnalysisAdmission(f.taskId, ERROR).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error as Error;
      expect(cause.message).toContain("fixture_admission_update_failure");
      const [after] = await pg<{ status: string; result: unknown }[]>`SELECT status,result FROM tasks WHERE id=${f.taskId}`;
      const [holdAfter] = await pg<{ value: unknown }[]>`SELECT to_jsonb(h) AS value FROM credit_holds h WHERE reference_id=${f.taskId}`;
      expect(after).toEqual(before); expect(holdAfter).toEqual(holdBefore);
    } finally {
      await pg.unsafe(`DROP TRIGGER reject_analysis_admission ON ${table}`);
      await pg.unsafe("DROP FUNCTION reject_analysis_admission()");
    }
  });

  it.each(["error-result", "result-error", "result-result"] as const)("serializes %s under the original task PK lock", async (order) => {
    const f = await seedOpen(); let release!: () => void; let opened!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { opened = resolve; });
    const held = pg.begin(async (tx) => { await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; opened(); await gate; });
    await active;
    const first = order.startsWith("error") ? fail(f) : record(f); void first.catch(() => undefined);
    let second: Promise<MiniToolAnalysisRecord> | undefined;
    try {
      await waitUntilBlockedOn(pg, ["tasks", "for update"], 1);
      second = order === "result-error" ? fail(f) : record(f); void second.catch(() => undefined);
      await waitUntilBlockedOn(pg, ["tasks", "for update"], 2);
      release(); await held; await Promise.all([first, second]);
      const stored = (await snapshot(f)).task;
      expect(stored.status).toBe(order === "error-result" ? "failed" : "completed");
      expect(stored.result.analysis).toEqual({ ...f.initial, status: order === "error-result" ? "failed" : "completed", result: f.result, error: order === "error-result" ? ERROR : null });
    } finally { release(); await held; await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });

  it.each(["result", "error"] as const)("publishes its %s state and metadata in one visible transaction", async (event) => {
    const f = await seedOpen(); const before = await snapshot(f); const key = crypto.randomInt(1, 2 ** 30);
    let release!: () => void; let opened!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { opened = resolve; });
    const held = pg.begin(async (tx) => { await tx`SELECT pg_advisory_xact_lock(${key})`; opened(); await gate; });
    await active;
    const slot = event === "result" ? "result" : "error";
    await pg.unsafe(`CREATE OR REPLACE FUNCTION gate_analysis_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND jsonb_typeof(NEW.result->'analysis'->'${slot}')='object' THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER gate_analysis_metadata BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION gate_analysis_metadata()");
    const writing = event === "result" ? record(f) : fail(f); void writing.catch(() => undefined);
    try {
      await waitUntilBlockedOn(pg, ["tasks", "update"], 1);
      expect(await snapshot(f)).toEqual(before);
      release(); await held; const committed = await writing;
      const after = await snapshot(f);
      expect(after.task.status).toBe(event === "result" ? "completed" : "failed");
      expect(after.task.result.analysis).toEqual(committed);
      assertPreserved(before, after);
    } finally {
      release(); await held; await writing.catch(() => undefined);
      await pg.unsafe("DROP TRIGGER gate_analysis_metadata ON tasks");
      await pg.unsafe("DROP FUNCTION gate_analysis_metadata()");
    }
  });

  it("preserves the state-table invariants under repeated result and error sequences", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("result", "error"), { minLength: 1, maxLength: 6 }), async (events) => {
      const f = await seedOpen(); const before = await snapshot(f);
      for (const event of events) await (event === "result" ? record(f) : fail(f));
      const after = await snapshot(f); const success = events[0] === "result";
      expect(after.task.status).toBe(success ? "completed" : "failed");
      expect(after.task.result.analysis).toEqual({ ...f.initial, status: success ? "completed" : "failed", result: events.includes("result") ? f.result : null, error: success ? null : ERROR });
      assertPreserved(before, after);
    }), { numRuns: 12 });
  });
});
