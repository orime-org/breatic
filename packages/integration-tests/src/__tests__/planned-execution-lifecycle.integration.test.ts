// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** SQL, steps, consumption, node tasks and history are real. Only external provider/upload and queue controls are controlled. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { DelayedError, type Job } from "bullmq";
import { createPgClient, currentConsent, getMiniToolsConfig, getNodeTaskConfig, getStreamRedis, initCore, initLogger, loadLocales, logger } from "@breatic/core";
import {
  beginMiniToolStepAttempt, miniToolStepStateSchema, recordMiniToolStepIdentity, recordMiniToolStepResult,
  taskRepo, upstreamStepRepo, modelCatalog, type MiniToolExecutionJob,
} from "@breatic/domain";
import { NO_CONSENT, type ConsentSnapshot } from "@breatic/shared";
import type { MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import type * as uploadModule from "@worker/handlers/backend-upload.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { runTask } from "@worker/handlers/dispatch.js";
import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { runMiniToolExecutionTask } from "@worker/handlers/mini-tool/run-execution-task.js";
import { executionSnapshot, seedExecution, storeExecutionFixture, type ExecutionFixture } from "../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";
import { fakeIngestJobs, INGEST_ENV } from "./ingest-jobs-fake.js";
import * as shared from "@breatic/shared";

/**
 * The provider body once the single first-attempt preparation is done: the prepared object's public URL replaces the
 * frozen reference (E3b; design §5.3).
 * @param f - The fixture.
 * @returns The resolved body.
 */
function resolvedBody(f: ExecutionFixture): Record<string, unknown> {
  const keyFor = (shared as unknown as { videoPresentationWorkKeyFor: (key: string, id: string) => string }).videoPresentationWorkKeyFor;
  return { ...f.plan.body, video: `https://assets.example.test/${keyFor(f.plan.sourceKey, `${f.taskId}:prep:0:a1`)}.mp4` };
}

const { runPrediction, storeFromUrl } = vi.hoisted(() => ({ runPrediction: vi.fn<typeof wavespeedModule.runPrediction>(), storeFromUrl: vi.fn<typeof uploadModule.storeFromUrl>() }));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction }));
vi.mock("@worker/handlers/backend-upload.js", async (original) => ({ ...await original<typeof uploadModule>(), storeFromUrl }));
const P = "original-lifecycle-prediction";
const TEMP = "https://provider.example.test/original.webm";
let pg: ReturnType<typeof createPgClient>;

beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "unused-lifecycle-key", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV }); loadLocales(); initLogger("planned-execution-fixture");
  pg = createPgClient(inject("DATABASE_URL"), { name: "planned-wrapper-fixtures", max: 6 });
});
// S6e E3b (inner#1306 §90): the removal's model input is prepared on standard-4 before generate.
beforeEach(() => { vi.resetAllMocks(); fakeIngestJobs(); });
afterAll(async () => { await pg.end(); initCore(process.env); vi.unstubAllGlobals(); });

/** Build the actual narrow producer envelope, with local queue controls only.
 * @throws {never} Never.
 */
function job(f: ExecutionFixture, attemptsMade = 0): Job<MiniToolExecutionJob> {
  return { id: `planned-${f.taskId}`, name: "execute-mini-tool", data: { taskId: f.taskId, source: "mini_tool", executionKind: "planned" },
    attemptsMade, opts: { attempts: 3 }, updateData: vi.fn().mockRejectedValue(new Error("Legacy task update was reached")), extendLock: vi.fn().mockResolvedValue(1), moveToDelayed: vi.fn().mockResolvedValue(undefined) } as unknown as Job<MiniToolExecutionJob>;
}
/** Invoke the production dispatcher without widening the producer's actual payload.
 * @throws {Error} When the actual task execution rejects.
 */
async function dispatch(j: Job<MiniToolExecutionJob>, token = "owned-token"): Promise<Record<string, unknown>> {
  return runTask(j, token);
}
/** Build ordinary source and output task rows; no Yjs node or layout is fabricated.
 * @throws {Error} On a fixture SQL failure.
 */
async function nodes(f: ExecutionFixture, targetStatus = "running"): Promise<void> {
  await pg`INSERT INTO node_tasks (project_id,space_id,node_id,kind,action,status,started_by_user_id,budget_ms,label,task_id)
    VALUES (${f.projectId},${f.plan.spaceId},${f.plan.outputs[0]!.nodeId},'generation','mini_tool',${targetStatus},${f.userId},${getNodeTaskConfig().default_budget_ms},'planned',${f.taskId})`;
  await pg`INSERT INTO node_history (project_id,node_id,user_id,entry_type,status,content) VALUES (${f.projectId},${f.plan.draft.source.nodeId},${f.userId},'upload','success',${f.plan.binding.canonicalURL})`;
}
/** Return a controlled remote result while persisting its identity through the production callback.
 * @throws {Error} If the real identity callback fails.
 */
function remote(f: ExecutionFixture): void {
  runPrediction.mockImplementation(async (_connection, _model, _body, resume) => {
    if (resume.storedTaskId === null) await resume.persistTaskId(P); return { taskId: resume.storedTaskId ?? P, outputs: [TEMP] };
  });
  storeFromUrl.mockResolvedValue({ assetId: f.registered.assetId, fileUrl: f.registered.canonicalURL, kind: "video", coverUrl: null,
    width: 960, height: 540, durationSeconds: 5.013, mimeType: "video/webm", sizeBytes: 1588436 });
}
/** Read real private execution facts as a test-side observer, never as a public GET implementation.
 * @throws {Error} If a fixture owner disappears.
 */
async function onlyStep(f: ExecutionFixture): Promise<Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number]> {
  // Preparation container_job rows precede the one generate step (E3b).
  const rows = (await upstreamStepRepo.listSteps(f.taskId)).filter((row) => row.kind === "generate"); expect(rows).toHaveLength(1); return rows[0]!;
}
/** Seed a pre-existing returned fact using the actual step owner, independent from any new wrapper.
 * @throws {Error} When original persistence fails.
 */
async function returned(f: ExecutionFixture, receipt = false): Promise<void> {
  const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing fixture step");
  const task = await taskRepo.getMiniToolExecutionTask(f.taskId); if (!task) throw new Error("Missing fixture task"); const attemptId = randomUUID();
  await beginMiniToolStepAttempt({ taskId: f.taskId, stepId: s.id, attemptId, deadlineAt: await taskDeadline(task.id, task.createdAt), requestBody: { ...f.plan.body }, chargeTo: "user" });
  await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: s.id, attemptId, predictionId: P });
  await recordMiniToolStepResult({ taskId: f.taskId, stepId: s.id, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, outcome: "done", result: [TEMP] },
    { kind: "generate", parse: () => ({ providerURL: TEMP }) });
  if (receipt) await upstreamStepRepo.recordInline(s.id, { "miniToolAsset:0": f.registered.assetId }, 0);
}
/** Seed the already committed terminal namespace to isolate replay from computation.
 * @throws {Error} On a fixture SQL failure.
 */
async function terminal(f: ExecutionFixture, status: "completed" | "failed" | "cancelled"): Promise<MiniToolExecutionRecord> {
  const record: MiniToolExecutionRecord = { ...f.record, status, resultVersion: 1, error: status === "failed" ? { code: "original_failure" } : null,
    outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: status === "failed" }] };
  await pg`UPDATE tasks SET status=${status},completed_at=clock_timestamp() WHERE id=${f.taskId}`; await storeExecutionFixture(pg, f, record); return record;
}
/** Inspect only persisted media, fee and original-source history observations.
 * @throws {Error} On a fixture SQL failure.
 */
async function observations(f: ExecutionFixture): Promise<{ record: MiniToolExecutionRecord; target: unknown[]; source: unknown[]; nodes: unknown[] }> {
  const parent = await executionSnapshot(pg, f);
  const target = await pg`SELECT content,status,task_id FROM node_history WHERE node_id=${f.plan.outputs[0]!.nodeId} ORDER BY created_at`;
  const source = await pg`SELECT content,status,task_id FROM node_history WHERE node_id=${f.plan.draft.source.nodeId} ORDER BY created_at`;
  const row = await pg`SELECT node_id,status,node_history_id FROM node_tasks WHERE task_id=${f.taskId}`;
  return { record: parent.result.miniToolExecution as MiniToolExecutionRecord, target: [...target], source: [...source], nodes: [...row] };
}

describe("narrow planned job reaches the original persistent lifecycle", () => {
  it("W01/W04 uses SQL F and original D instead of poisoned queue context and current UI claims", async () => {
    const f = await seedExecution(pg, "pending", false); await nodes(f); remote(f); const j = job(f);
    Object.assign(j.data, { userId: "queue-actor", projectId: "queue-project", model: "queue-model", params: { video: "https://foreign.example.test/wrong.mp4" }, targetNodeIds: [randomUUID()] });
    const task = await taskRepo.getMiniToolExecutionTask(f.taskId); if (!task) throw new Error("Missing fixture task"); const d = await taskDeadline(task.id, task.createdAt);
    await dispatch(j);
    const actual = await observations(f); expect(actual.record).toMatchObject({ runId: f.taskId, status: "completed", resultVersion: 1, outputs: [{ ...f.plan.outputs[0], result: f.registered, late: false }] });
    expect(runPrediction).toHaveBeenCalledExactlyOnceWith(expect.any(Object), f.plan.provider.model_id, resolvedBody(f), expect.objectContaining({ deadlineAt: d, retryStarting: false }));
    // Storing the finished prediction is bounded by the read bound: the reporting window (two polls past D) here.
    expect(storeFromUrl).toHaveBeenCalledExactlyOnceWith(TEMP, expect.objectContaining({ actingUserId: f.userId, projectId: f.projectId, generationTaskId: f.taskId,
      deadlineAt: d + 2 * getMiniToolsConfig().poll_interval_ms, knownAlpha: true }));
    expect(actual.source).toEqual([{ content: f.plan.binding.canonicalURL, status: "success", task_id: null }]); expect(actual.target).toEqual([{ content: f.registered.canonicalURL, status: "success", task_id: f.taskId }]);
  });
  it("W04 does not re-resolve source or reselect the currently served catalog model", async () => {
    const f = await seedExecution(pg); remote(f); expect(modelCatalog.getModelCatalog().video.some((m) => m.name === f.plan.model)).toBe(false);
    await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.plan.binding.assetId}`;
    await runMiniToolExecutionTask(job(f), "token"); expect(runPrediction).toHaveBeenCalledExactlyOnceWith(expect.any(Object), f.plan.provider.model_id, resolvedBody(f), expect.any(Object)); expect((await executionSnapshot(pg, f)).params).toEqual({ miniToolExecution: f.plan });
  });
  it("W15 sees active0 before the first adapter and sees pending mirror immediately after the actual identity callback", async () => {
    const f = await seedExecution(pg, "pending", false); remote(f);
    runPrediction.mockImplementation(async (_connection, _model, _body, resume) => {
      // The preparation container_job already opened its pending container consumption before generate (E3b; §7.6, execution design §6.22).
      const preparation = (await upstreamStepRepo.listSteps(f.taskId)).filter((row) => row.kind === "container_job")
        .map((row) => (row.output.miniToolConsumption as { consumptionKey: string }).consumptionKey);
      expect(preparation).toHaveLength(1);
      const before = (await observations(f)).record;
      expect(before).toMatchObject({ status: "running", resultVersion: 0, outputs: [{ ...f.plan.outputs[0], result: null, late: false }] });
      expect(before.usage).toEqual([expect.objectContaining({ consumptionKey: preparation[0], state: "pending", costUsd: null, credits: null })]);
      await resume.persistTaskId(P); const step = await onlyStep(f);
      const provider = { consumptionKey: (step.output.miniToolConsumption as { consumptionKey: string }).consumptionKey, state: "pending", chargeTo: "user", costUsd: null, credits: null };
      expect((await observations(f)).record.usage).toEqual(expect.arrayContaining([provider, expect.objectContaining({ consumptionKey: preparation[0], state: "pending" })]));
      expect((await observations(f)).record.usage).toHaveLength(2);
      return { taskId: P, outputs: [TEMP] };
    });
    await runMiniToolExecutionTask(job(f), "token"); expect(runPrediction).toHaveBeenCalledTimes(1);
  });
  it("W15 leaves provider and registration untouched when namespace initialization fails", async () => {
    const f = await seedExecution(pg, "pending", false); remote(f); const before = await executionSnapshot(pg, f);
    await pg.unsafe(`CREATE FUNCTION reject_planned_init() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result ? 'miniToolExecution' THEN RAISE EXCEPTION 'fixture_planned_init_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_planned_init BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_planned_init()");
    try { await expect(runMiniToolExecutionTask(job(f), "token")).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_planned_init_failed") } }); }
    finally { await pg.unsafe("DROP TRIGGER reject_planned_init ON tasks"); await pg.unsafe("DROP FUNCTION reject_planned_init()"); }
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled(); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["model", "body", "hash"])("W02/W03 rejects damaged SQL %s before paid or media effects", async (bad) => {
    const f = await seedExecution(pg, "pending", false); remote(f);
    if (bad === "model") await pg`UPDATE tasks SET model='different' WHERE id=${f.taskId}`;
    else { const plan = structuredClone(f.plan); if (bad === "body") Object.assign(plan.body, { preserve_audio: false }); else plan.planFingerprint = plan.requestFingerprint;
      await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...plan } })} WHERE id=${f.taskId}`; }
    const before = await executionSnapshot(pg, f); await expect(runMiniToolExecutionTask(job(f), "token")).rejects.toBeInstanceOf(Error);
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled(); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("W marker does not silently send a real SQL planned task through a markerless legacy delivery", async () => {
    const f = await seedExecution(pg); const j = job(f); Reflect.deleteProperty(j.data, "executionKind"); remote(f);
    await expect(dispatch(j)).rejects.toBeInstanceOf(Error); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled(); expect((await executionSnapshot(pg, f)).status).toBe("pending");
  });
  it.each([undefined, { analytics: true, ads: false }] as const)("W14 retains the original consent default or actual queue snapshot %j", async (consent) => {
    const f = await seedExecution(pg); remote(f); const j = job(f); if (consent) j.data.analyticsConsent = consent;
    let observed: ConsentSnapshot | null = null;
    runPrediction.mockImplementation(async (_c, _m, _b, resume) => { observed = currentConsent(); await resume.persistTaskId(P); return { taskId: P, outputs: [TEMP] }; });
    await dispatch(j); expect(observed).toEqual(consent ?? NO_CONSENT);
  });
});

describe("original waiting and returned-provider boundary", () => {
  it("W05 moves the actual wait to delayed without terminal rows or closing the unresolved identity set", async () => {
    const f = await seedExecution(pg); const j = job(f); const wait = new StillRunning(Date.now() + 5000);
    runPrediction.mockRejectedValue(wait);
    await expect(runMiniToolExecutionTask(j, "token")).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledExactlyOnceWith(wait.resumeAt, "token"); expect((await executionSnapshot(pg, f)).status).toBe("running"); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("W06 returns a tokenless wait unchanged to the direct caller", async () => {
    const f = await seedExecution(pg); const j = job(f); const wait = new StillRunning(Date.now() + 5000); runPrediction.mockRejectedValue(wait);
    await expect(runMiniToolExecutionTask(j)).rejects.toBe(wait); expect(j.moveToDelayed).not.toHaveBeenCalled(); expect((await executionSnapshot(pg, f)).status).toBe("running");
  });
  it("W06 preserves a failed moveToDelayed without claiming terminal control", async () => {
    const f = await seedExecution(pg); const j = job(f); runPrediction.mockRejectedValue(new StillRunning(Date.now() + 5000)); const error = new Error("queue move unavailable"); vi.mocked(j.moveToDelayed).mockRejectedValue(error);
    await expect(runMiniToolExecutionTask(j, "token")).rejects.toBe(error); expect((await executionSnapshot(pg, f)).status).toBe("running");
  });
  it("W07 throws a pre-return retryable original error without manufacturing a terminal snapshot", async () => {
    const f = await seedExecution(pg); const error = new TypeError("fixture pre-return connection failure"); runPrediction.mockRejectedValue(error);
    await expect(runMiniToolExecutionTask(job(f), "token")).rejects.toBe(error); const row = await executionSnapshot(pg, f); expect(row.status).toBe("running"); expect((row.result.miniToolExecution as MiniToolExecutionRecord).resultVersion).toBe(0);
  });
  it("W07 exhausted attempt ends failed but leaves the unresolved actual intent pending", async () => {
    const f = await seedExecution(pg); runPrediction.mockRejectedValue(new Error("fixture pre-return terminal error"));
    await runMiniToolExecutionTask(job(f, 2), "token"); const row = await executionSnapshot(pg, f); expect(row.status).toBe("failed"); expect(row.result.settlement).toMatchObject({ consumptionSetComplete: false });
  });
  it("W16 a terminal pre-return failure whose completion write fails throws for retry: preparation done is not the vendor's return", async () => {
    const f = await seedExecution(pg); runPrediction.mockRejectedValue(new Error("fixture pre-return terminal error"));
    const fn = `reject_failed_completion_${f.taskId.replaceAll("-", "")}`;
    await pg.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result->'miniToolExecution'->>'status' = 'failed' THEN RAISE EXCEPTION 'fixture_completion_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(runMiniToolExecutionTask(job(f, 2), "token")).rejects.toThrow();
      const steps = await upstreamStepRepo.listSteps(f.taskId);
      // The preparation ran and finished; the vendor (generate) never returned.
      expect(steps.some((step) => step.kind === "container_job")).toBe(true);
      expect(steps.filter((step) => step.kind === "generate").every((step) => step.output.miniToolStep === undefined
        || miniToolStepStateSchema.parse(step.output.miniToolStep).result?.outcome !== "done")).toBe(true);
    } finally {
      await pg.unsafe(`DROP TRIGGER ${fn} ON tasks`); await pg.unsafe(`DROP FUNCTION ${fn}()`);
    }
  });
  it("W07 preserves the original known upstream-failure classifier without spending another retry", async () => {
    const f = await seedExecution(pg); runPrediction.mockImplementation(async (_c, _m, _b, resume) => { await resume.persistTaskId(P); throw new UpstreamTaskFailed("wavespeed", "fixture upstream rejected"); });
    await runMiniToolExecutionTask(job(f, 0), "token"); expect((await executionSnapshot(pg, f)).status).toBe("failed"); expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("W07 honors the expired original budget rather than starting a new paid attempt", async () => {
    const f = await seedExecution(pg); await pg`UPDATE tasks SET created_at=clock_timestamp() - interval '3 hours' WHERE id=${f.taskId}`;
    await runMiniToolExecutionTask(job(f), "token"); const r = (await observations(f)).record; expect(r.status).toBe("failed"); expect(r.error).toMatchObject({ code: "expired" }); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it.each([false, true])("W08/W10 never throws after a persisted return, pre-existing=%s", async (preexisting) => {
    const f = await seedExecution(pg, "running"); remote(f); if (preexisting) await returned(f); storeFromUrl.mockRejectedValue(new Error("fixture canonical registration unavailable"));
    const errorLog = vi.spyOn(logger, "error");
    try { await runMiniToolExecutionTask(job(f), "token"); const row = await executionSnapshot(pg, f); expect(row.status).toBe("failed");
      const s = await onlyStep(f); expect(miniToolStepStateSchema.parse(s.output.miniToolStep).result).toMatchObject({ outcome: "done", result: { providerURL: TEMP } });
      expect((s.output.miniToolConsumption as { state: string }).state).toBe("pending"); expect(errorLog.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: expect.any(Error), ctx: expect.objectContaining({ taskId: f.taskId, stepId: s.id, phase: expect.any(String) }) })])])); expect(runPrediction).toHaveBeenCalledTimes(preexisting ? 0 : 1);
    } finally { errorLog.mockRestore(); }
  });
  it("W08 contains receipt-persistence failure after a registered winner was returned", async () => {
    const f = await seedExecution(pg); remote(f);
    await pg.unsafe(`CREATE FUNCTION reject_planned_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${f.taskId}'::uuid AND NEW.output ? 'miniToolAsset:0' THEN RAISE EXCEPTION 'fixture_receipt_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_planned_receipt BEFORE UPDATE ON task_upstream_steps FOR EACH ROW EXECUTE FUNCTION reject_planned_receipt()");
    try { await runMiniToolExecutionTask(job(f), "token"); expect((await executionSnapshot(pg, f)).status).toBe("failed"); expect(storeFromUrl).toHaveBeenCalledTimes(1); }
    finally { await pg.unsafe("DROP TRIGGER reject_planned_receipt ON task_upstream_steps"); await pg.unsafe("DROP FUNCTION reject_planned_receipt()"); }
  });
  it.each(["completed", "failed", "cancelled"] as const)("W11/M12 replays %s without provider, transfer or a new attempt", async (status) => {
    const f = await seedExecution(pg); const original = await terminal(f, status);
    await runMiniToolExecutionTask(job(f), "token"); expect((await observations(f)).record).toEqual(original); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled(); expect(await upstreamStepRepo.listSteps(f.taskId)).toEqual([]);
  });
  it.each([false, true])("W12 a lost execution lock prevents final state, history and node writes after returned=%s", async (failed) => {
    const f = await seedExecution(pg); await nodes(f); remote(f); const j = job(f); vi.mocked(j.extendLock).mockResolvedValue(0);
    if (failed) storeFromUrl.mockRejectedValue(new Error("fixture transfer failed"));
    await runMiniToolExecutionTask(j, "stale-token"); const actual = await observations(f); expect((await executionSnapshot(pg, f)).status).toBe("running"); expect(actual.record.resultVersion).toBe(0); expect(actual.target).toEqual([]); expect(actual.nodes).toMatchObject([{ status: "running" }]);
  });
  it("W12 does not interpret an actual lock-extension failure as retained ownership", async () => {
    const f = await seedExecution(pg); remote(f); const j = job(f); vi.mocked(j.extendLock).mockRejectedValue(new Error("fixture Redis lock failure"));
    try { await runMiniToolExecutionTask(j, "token"); } catch { /* The error classification is not this fixture's assertion. */ }
    expect((await executionSnapshot(pg, f)).status).toBe("running"); expect((await observations(f)).target).toEqual([]);
  });
});

describe("terminal media delivery and cross-process cleanup", () => {
  it.each(["node_history", "node_tasks"] as const)("W09 retains completed manifest after %s persistence fails and replays without recomputation", async (table) => {
    const f = await seedExecution(pg); await nodes(f); remote(f);
    await pg.unsafe(`CREATE FUNCTION reject_planned_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${f.taskId}'::uuid THEN RAISE EXCEPTION 'fixture_delivery_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe(`CREATE TRIGGER reject_planned_delivery BEFORE ${table === "node_history" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_planned_delivery()`);
    try { await runMiniToolExecutionTask(job(f), "token"); const actual = await observations(f); expect(actual.record).toMatchObject({ status: "completed", resultVersion: 1, outputs: [{ result: f.registered }] }); }
    finally { await pg.unsafe(`DROP TRIGGER reject_planned_delivery ON ${table}`); await pg.unsafe("DROP FUNCTION reject_planned_delivery()"); }
    await runMiniToolExecutionTask(job(f), "token"); expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).toHaveBeenCalledTimes(1); expect((await observations(f)).target).toEqual([{ content: f.registered.canonicalURL, status: "success", task_id: f.taskId }]);
  });
  it.each(["failed", "done"] as const)("M08/M10 retains a target already %s while keeping canonical history available", async (nodeStatus) => {
    const f = await seedExecution(pg, "running"); await nodes(f, nodeStatus); await returned(f, true);
    await runMiniToolExecutionTask(job(f), "token"); const actual = await observations(f); expect(actual.nodes).toMatchObject([{ status: nodeStatus }]); expect(actual.target).toEqual([{ content: f.registered.canonicalURL, status: "success", task_id: f.taskId }]);
  });
  it("M10 publishes recovery history without inventing a missing target node/task or resetting D", async () => {
    const f = await seedExecution(pg, "running"); await returned(f, true); const before = miniToolStepStateSchema.parse((await onlyStep(f)).output.miniToolStep).deadlineAt;
    await runMiniToolExecutionTask(job(f), "token"); const actual = await observations(f); expect(actual.record.status).toBe("completed"); expect(actual.nodes).toEqual([]); expect(actual.target).toEqual([{ content: f.registered.canonicalURL, status: "success", task_id: f.taskId }]); expect(miniToolStepStateSchema.parse((await onlyStep(f)).output.miniToolStep).deadlineAt).toBe(before);
  });
  it("M11 keeps canonical media when the controlled receipt reports presentationQueueFailed", async () => {
    const f = await seedExecution(pg); remote(f); storeFromUrl.mockResolvedValue({ assetId: f.registered.assetId, fileUrl: f.registered.canonicalURL, kind: "video", coverUrl: null, width: 960, height: 540, durationSeconds: 5.013, mimeType: "video/webm", sizeBytes: 1588436, presentationQueueFailed: true });
    await runMiniToolExecutionTask(job(f), "token"); expect((await observations(f)).record.outputs[0]!.result).toEqual(f.registered); expect((await observations(f)).record.status).toBe("completed");
  });
  it("W13 ignores a nonterminal failed event even if ordinary attempts were exhausted", async () => {
    const f = await seedExecution(pg); const before = await executionSnapshot(pg, f); const j = Object.assign(job(f, 999), { finishedOn: undefined });
    expect(await cleanupFailedJobNodes(getStreamRedis(), j as unknown as Parameters<typeof cleanupFailedJobNodes>[1], "retrying")).toBe(0); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("W13 terminal stalled death with zero attempts uses planned finish and keeps unresolved consumption/hold", async () => {
    const f = await seedExecution(pg, "running"); await returned(f); await nodes(f);
    await pg`INSERT INTO credit_holds (studio_id,actor_user_id,reference_id,amount,status,expires_at) VALUES (${f.studioId},${f.userId},${f.taskId},30,'held','2099-01-01T00:00:00Z')`;
    const j = Object.assign(job(f, 0), { finishedOn: Date.now() });
    await cleanupFailedJobNodes(getStreamRedis(), j, "stalled");
    expect((await executionSnapshot(pg, f)).status).toBe("failed"); const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" }); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
});
