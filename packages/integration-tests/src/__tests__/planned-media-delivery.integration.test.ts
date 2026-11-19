// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** SQL, canonical rows, history, node tasks and both Redis databases are real. */
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, createQueue, getNodeTaskConfig, getStreamRedis, initCore, initLogger, loadLocales, logger, taskEventsStreamKey } from "@breatic/core";
import { miniToolExecutionService } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import { runTask } from "@worker/handlers/dispatch.js";
import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";
import { finishMiniToolExecutionAndNotify } from "@worker/handlers/mini-tool/execution-completion.js";
import * as wavespeed from "@worker/providers/wavespeed.js";
import * as upload from "@worker/handlers/backend-upload.js";
import { seedExecution, type ExecutionFixture } from "../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";

let pg: ReturnType<typeof createPgClient>;
let yjsPg: ReturnType<typeof createPgClient>;
let queue: Queue<Record<string, unknown>>;

beforeAll(() => {
  initCore({ ...process.env, ENV: "staging", PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", UPLOAD_BASE_URL: "https://assets.example.test" });
  loadLocales(); initLogger("planned-delivery-fixture");
  pg = createPgClient(inject("DATABASE_URL"), { name: "planned-delivery-sql", max: 4 });
  yjsPg = createPgClient(inject("YJS_DATABASE_URL"), { name: "planned-delivery-yjs", max: 1 });
  queue = createQueue("tasks");
});
beforeEach(() => {
  vi.spyOn(wavespeed, "runPrediction").mockRejectedValue(new Error("Pure delivery must not call a provider"));
  vi.spyOn(upload, "storeFromUrl").mockRejectedValue(new Error("Pure delivery must not transfer or register media"));
});
afterEach(() => {
  try { expect(wavespeed.runPrediction).not.toHaveBeenCalled(); expect(upload.storeFromUrl).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); }
});
afterAll(async () => { await pg.end(); await yjsPg.end(); initCore(process.env); });

/** Build valid persisted pending delivery from the existing real canonical-manifest fixture.
 * @throws {Error} When original fixture persistence fails.
 */
async function fixture(nodeStatus: "running" | "failed" | "expired" | "missing" = "running"): Promise<ExecutionFixture> {
  const f = await seedExecution(pg, "running");
  await miniToolExecutionService.finishMiniToolExecution(f.taskId, { planFingerprint: f.plan.planFingerprint, expectedVersion: 0,
    outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }], error: null });
  // Seed the independently specified delivery projection, not its future mapper.
  await pg`UPDATE tasks SET result=result || ${pg.json({ miniToolDelivery: pending(f) })} WHERE id=${f.taskId}`;
  if (nodeStatus !== "missing") {
    const startedAt = new Date(Date.now() - (nodeStatus === "expired" ? getNodeTaskConfig().default_budget_ms + 1 : 0));
    if (nodeStatus === "expired") await pg`UPDATE tasks SET created_at=${startedAt} WHERE id=${f.taskId}`;
    await pg`INSERT INTO node_tasks (project_id,space_id,node_id,kind,action,status,started_by_user_id,budget_ms,label,task_id,started_at,settled_at)
      VALUES (${f.projectId},${f.plan.spaceId},${f.plan.outputs[0]!.nodeId},'generation','mini_tool',${nodeStatus},${f.userId},${getNodeTaskConfig().default_budget_ms},'delivery',${f.taskId},${startedAt},${nodeStatus === "running" ? null : new Date()})`;
  }
  await pg`INSERT INTO node_history (project_id,node_id,user_id,entry_type,status,content)
    VALUES (${f.projectId},${f.plan.draft.source.nodeId},${f.userId},'upload','success',${f.plan.binding.canonicalURL})`;
  await pg`INSERT INTO credit_holds (studio_id,actor_user_id,reference_id,amount,status,expires_at)
    VALUES (${f.studioId},${f.userId},${f.taskId},30,'held','2099-01-01T00:00:00Z')`;
  return f;
}

/** Return the adopted literal internal pending state, independent of production mapping.
 * @throws {never} Never.
 */
function pending(f: ExecutionFixture, errorCode: string | null = null): { schemaVersion: number; planFingerprint: string; version: number; outputs: Array<{ outputIndex: number; state: string }>; lastErrorCode: string | null } {
  return { schemaVersion: 1, planFingerprint: f.plan.planFingerprint, version: 1, outputs: [{ outputIndex: 0, state: "pending" }], lastErrorCode: errorCode };
}

/** Construct only the strict adopted tasks-queue wake data, without copied execution context.
 * @throws {never} Never.
 */
function wake(f: ExecutionFixture): Parameters<typeof runTask>[0] {
  return { id: `delivery-${f.taskId}-1`, name: "deliver-mini-tool-results", data: { taskId: f.taskId, deliveryVersion: 1 } } as unknown as Parameters<typeof runTask>[0];
}

/** Read the SQL delivery sibling directly as an independent observer.
 * @throws {Error} When the original task disappeared or the query fails.
 */
async function deliveryState(f: ExecutionFixture): Promise<unknown> {
  const [row] = await pg`SELECT result->'miniToolDelivery' AS delivery FROM tasks WHERE id=${f.taskId}`;
  if (!row) throw new Error("Original delivery task disappeared"); return row.delivery;
}

/** Snapshot original computation, source, expense, hold and registration facts apart from delivery.
 * @throws {Error} When a fixture query fails.
 */
async function invariants(f: ExecutionFixture): Promise<Record<string, unknown>> {
  return {
    parent: [...await pg`SELECT status,model,params,result - 'miniToolDelivery' AS result,created_at::text,completed_at::text,billed_at::text,billed_credits::text FROM tasks WHERE id=${f.taskId}`],
    hold: [...await pg`SELECT reference_id,amount::text,status,expires_at::text FROM credit_holds WHERE reference_id=${f.taskId}`],
    usage: [...await pg`SELECT * FROM agent_usage_records WHERE project_id=${f.projectId}`],
    ledger: [...await pg`SELECT * FROM credit_ledger WHERE reference_id=${f.taskId}`],
    steps: [...await pg`SELECT * FROM task_upstream_steps WHERE task_id=${f.taskId}`],
    source: [...await pg`SELECT * FROM node_history WHERE project_id=${f.projectId} AND node_id=${f.plan.draft.source.nodeId}`],
    assets: [...await pg`SELECT * FROM studio_assets WHERE studio_id=${f.studioId} ORDER BY id`],
  };
}

/** Read actual stream payloads for this original target without replacing XADD or history.
 * @throws {Error} When Redis or its stored payload is invalid.
 */
async function events(f: ExecutionFixture): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  return (await getStreamRedis().xrange(taskEventsStreamKey(), "-", "+")).flatMap(([id, fields]) => {
    const index = fields.indexOf("payload"); if (index < 0) throw new Error("Stream entry has no payload");
    const value: unknown = JSON.parse(fields[index + 1]!);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Stream payload is not an object");
    const payload = value as Record<string, unknown>;
    return payload.nodeId === f.plan.outputs[0]!.nodeId ? [{ id, payload }] : [];
  });
}

/** Verify one canonical history row and no backend-created persisted canvas document.
 * @throws {Error} When history or persistence differs from the original registered output.
 */
async function history(f: ExecutionFixture): Promise<string> {
  const rows = await pg`SELECT id,content,status,media_width,media_height,duration_seconds::text,mime_type,size_bytes::text FROM node_history WHERE task_id=${f.taskId}`;
  expect([...rows]).toEqual([{ id: expect.any(String), content: f.registered.canonicalURL, status: "success", media_width: 960, media_height: 540,
    duration_seconds: "5.013", mime_type: "video/webm", size_bytes: "1588436" }]);
  expect([...await yjsPg`SELECT name FROM yjs_documents WHERE name=${canvasSpaceDocName(f.projectId, f.plan.spaceId)}`]).toEqual([]);
  return rows[0]!.id as string;
}

/** Assert the exact original media event identity rather than one transport identifier.
 * @throws {Error} When event media or its top-level logical identity differs.
 */
function expectMedia(payload: Record<string, unknown>, f: ExecutionFixture): void {
  expect(payload).toEqual({ type: "node-task-counts", docName: canvasSpaceDocName(f.projectId, f.plan.spaceId), nodeId: f.plan.outputs[0]!.nodeId,
    counts: { running: 0, done: 1, failed: 0, expired: 0 },
    result: { content: f.registered.canonicalURL, coverUrl: null, width: 960, height: 540, duration: 5.013, mimeType: "video/webm", size: 1588436 },
    resultOrigin: { kind: "mini-tool-output", runId: f.taskId, planFingerprint: f.plan.planFingerprint, outputIndex: 0 } });
}

describe("pure media delivery on the existing tasks queue", () => {
  it("D05 keeps committed pending after inline publication and wake-enqueue failures, then discovers the SQL identity", async () => {
    const f = await fixture(); const before = await invariants(f); const redis = getStreamRedis(); const key = taskEventsStreamKey();
    const originalType = await redis.type(key); const backup = `${key}:delivery-fixture:${randomUUID()}`;
    const addFailure = new Error("fixture delivery enqueue unavailable"); const add = vi.spyOn(Queue.prototype, "add").mockRejectedValueOnce(addFailure);
    if (originalType !== "none") await redis.rename(key, backup);
    try {
      await redis.set(key, "fixture wrong type");
      const result = await finishMiniToolExecutionAndNotify(f.taskId, { planFingerprint: f.plan.planFingerprint, expectedVersion: 1,
        outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }], error: null }, redis);
      expect(result.record.status).toBe("completed");
      expect(add).toHaveBeenCalledWith("deliver-mini-tool-results", { taskId: f.taskId, deliveryVersion: 1 }, expect.any(Object));
      expect(await deliveryState(f)).toEqual(pending(f, "delivery_publish_failed"));
    } finally { await redis.del(key); if (originalType !== "none") await redis.rename(backup, key); add.mockRestore(); }
    expect(await redis.type(key)).toBe(originalType); expect(await redis.exists(backup)).toBe(0);
    expect(await invariants(f)).toEqual(before);
    await runTask({ name: "discover-mini-tool-deliveries", data: {} } as unknown as Parameters<typeof runTask>[0]);
    const jobs = (await queue.getWaiting()).filter((job) => job.name === "deliver-mini-tool-results" && job.data.taskId === f.taskId);
    expect(jobs).toHaveLength(1); expect(jobs[0]!.data).toEqual({ taskId: f.taskId, deliveryVersion: 1 });
    expect(await deliveryState(f)).toEqual(pending(f, "delivery_publish_failed")); expect(await invariants(f)).toEqual(before);
  });

  it("D06/D15 acknowledges actual canonical publication without creating a Yjs target", async () => {
    const f = await fixture(); const before = await invariants(f);
    await runTask(wake(f));
    expect(await deliveryState(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: "published" }] });
    const actual = await events(f); expect(actual).toHaveLength(1); expectMedia(actual[0]!.payload, f);
    await history(f); expect(await invariants(f)).toEqual(before);
  });

  it("D07 leaves pending and logs the actual history stage when PostgreSQL rejects history", async () => {
    const f = await fixture(); const before = await invariants(f); const errors = vi.spyOn(logger, "error");
    await pg.unsafe(`CREATE FUNCTION reject_pure_delivery_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${f.taskId}'::uuid THEN RAISE EXCEPTION 'fixture_pure_history_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_pure_delivery_history BEFORE INSERT ON node_history FOR EACH ROW EXECUTE FUNCTION reject_pure_delivery_history()");
    try { await runTask(wake(f)); }
    finally { await pg.unsafe("DROP TRIGGER reject_pure_delivery_history ON node_history"); await pg.unsafe("DROP FUNCTION reject_pure_delivery_history()"); }
    expect(await deliveryState(f)).toEqual(pending(f, "delivery_history_failed")); expect(await events(f)).toEqual([]);
    expect([...await pg`SELECT id FROM node_history WHERE task_id=${f.taskId}`]).toEqual([]);
    expect(errors.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: expect.any(Error), ctx: expect.objectContaining({ taskId: f.taskId, deliveryVersion: 1, outputIndex: 0, stage: "history" }) })])]));
    expect(await invariants(f)).toEqual(before);
  });

  it("D08 retains one history after actual Redis failure and acknowledges the original identity on retry", async () => {
    const f = await fixture(); const before = await invariants(f); const redis = getStreamRedis(); const key = taskEventsStreamKey();
    const originalType = await redis.type(key); const backup = `${key}:delivery-fixture:${randomUUID()}`;
    if (originalType !== "none") await redis.rename(key, backup);
    try { await redis.set(key, "fixture wrong type"); await runTask(wake(f)); }
    finally { await redis.del(key); if (originalType !== "none") await redis.rename(backup, key); }
    expect(await redis.type(key)).toBe(originalType); expect(await redis.exists(backup)).toBe(0);
    expect(await deliveryState(f)).toEqual(pending(f, "delivery_publish_failed"));
    const originalHistory = await history(f); expect(await events(f)).toEqual([]); expect(await invariants(f)).toEqual(before);
    await runTask(wake(f));
    expect(await deliveryState(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: "published" }] });
    expect(await history(f)).toBe(originalHistory); const actual = await events(f); expect(actual).toHaveLength(1); expectMedia(actual[0]!.payload, f);
    expect(await invariants(f)).toEqual(before);
  });

  it.each(["failed", "expired"] as const)("D13 preserves the %s node row and records only history/counts disposition", async (status) => {
    const f = await fixture(status); const before = await invariants(f);
    const rows = [...await pg`SELECT id,status,settled_at::text FROM node_tasks WHERE task_id=${f.taskId}`];
    await runTask(wake(f));
    expect(await deliveryState(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: "history_only" }] });
    const actual = await events(f); expect(actual).toHaveLength(1);
    expect(actual[0]!.payload).toEqual({ type: "node-task-counts", docName: canvasSpaceDocName(f.projectId, f.plan.spaceId), nodeId: f.plan.outputs[0]!.nodeId,
      counts: { running: 0, done: 0, failed: status === "failed" ? 1 : 0, expired: status === "expired" ? 1 : 0 } });
    await history(f); expect([...await pg`SELECT id,status,settled_at::text FROM node_tasks WHERE task_id=${f.taskId}`]).toEqual(rows);
    expect(await invariants(f)).toEqual(before);
  });

  it("D09 preserves pending after real XADD succeeds but PostgreSQL rejects its acknowledgement", async () => {
    const f = await fixture(); const before = await invariants(f); const errors = vi.spyOn(logger, "error");
    await pg.unsafe(`CREATE FUNCTION reject_pure_delivery_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result->'miniToolDelivery'->'outputs'->0->>'state'='published' THEN RAISE EXCEPTION 'fixture_pure_ack_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_pure_delivery_ack BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_pure_delivery_ack()");
    try { await runTask(wake(f)); }
    finally { await pg.unsafe("DROP TRIGGER reject_pure_delivery_ack ON tasks"); await pg.unsafe("DROP FUNCTION reject_pure_delivery_ack()"); }
    expect(await deliveryState(f)).toEqual(pending(f, "delivery_ack_failed"));
    const first = await events(f); expect(first).toHaveLength(1); expectMedia(first[0]!.payload, f);
    const originalHistory = await history(f); expect(await invariants(f)).toEqual(before);
    expect(errors.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: expect.any(Error), ctx: expect.objectContaining({ taskId: f.taskId, deliveryVersion: 1, outputIndex: 0, stage: "ack" }) })])]));
    await runTask(wake(f));
    expect(await deliveryState(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: "published" }] });
    const second = await events(f); expect(second).toHaveLength(2); expect(second[1]!.id).not.toBe(second[0]!.id);
    for (const event of second) expectMedia(event.payload, f);
    expect(second[1]!.payload.resultOrigin).toEqual(second[0]!.payload.resultOrigin);
    expect(await history(f)).toBe(originalHistory); expect(await invariants(f)).toEqual(before);
  });

  it("does not publish or write another acknowledgement for completed old-version or future-version wakes", async () => {
    const f = await fixture(); const before = await invariants(f);
    await runTask(wake(f)); const originalHistory = await history(f); const originalEvents = await events(f); expect(originalEvents).toHaveLength(1);
    const [held] = await pg`SELECT updated_at::text FROM tasks WHERE id=${f.taskId}`; const errors = vi.spyOn(logger, "error");
    await pg.unsafe(`CREATE FUNCTION reject_redundant_delivery_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid THEN RAISE EXCEPTION 'fixture_redundant_delivery_write'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_redundant_delivery_write BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_redundant_delivery_write()");
    try {
      await runTask(wake(f));
      await runTask({ ...wake(f), data: { taskId: f.taskId, deliveryVersion: 999 } } as unknown as Parameters<typeof runTask>[0]);
    } finally { await pg.unsafe("DROP TRIGGER reject_redundant_delivery_write ON tasks"); await pg.unsafe("DROP FUNCTION reject_redundant_delivery_write()"); }
    expect(errors.mock.calls).toEqual([]);
    expect(await deliveryState(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: "published" }] });
    expect([...await pg`SELECT updated_at::text FROM tasks WHERE id=${f.taskId}`]).toEqual([held]);
    expect(await events(f)).toEqual(originalEvents); expect(await history(f)).toBe(originalHistory); expect(await invariants(f)).toEqual(before);
  });

  it("D14 treats the missing SQL node row as wiring failure and never acknowledges a silent return", async () => {
    const f = await fixture("missing"); const before = await invariants(f); const errors = vi.spyOn(logger, "error");
    await runTask(wake(f));
    expect(await deliveryState(f)).toEqual(pending(f, "delivery_node_task_missing")); expect(await events(f)).toEqual([]);
    expect([...await pg`SELECT id FROM node_tasks WHERE task_id=${f.taskId}`]).toEqual([]);
    expect([...await yjsPg`SELECT name FROM yjs_documents WHERE name=${canvasSpaceDocName(f.projectId, f.plan.spaceId)}`]).toEqual([]);
    expect(errors.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: expect.any(Error), ctx: expect.objectContaining({ taskId: f.taskId, deliveryVersion: 1, outputIndex: 0, stage: "node-task" }) })])]));
    expect(await invariants(f)).toEqual(before);
  });

  it("D16 restores a complete canonical manifest past original D with no new source resolution or paid work", async () => {
    const f = await fixture();
    await pg`UPDATE tasks SET created_at=clock_timestamp() - ${getNodeTaskConfig().default_budget_ms + 1}::double precision * interval '1 millisecond' WHERE id=${f.taskId}`;
    await pg`UPDATE studio_assets SET deleted_at=clock_timestamp() WHERE id=${f.plan.binding.assetId}`;
    const before = await invariants(f);
    await runTask(wake(f));
    expect(await deliveryState(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: "published" }] });
    const actual = await events(f); expect(actual).toHaveLength(1); expectMedia(actual[0]!.payload, f);
    await history(f); expect(await invariants(f)).toEqual(before);
  });

  it.each(["deliver-mini-tool-results", "discover-mini-tool-deliveries"])("D18 cross-process cleanup ignores terminal %s without releasing funds or changing computation", async (name) => {
    const f = await fixture(); const before = await invariants(f);
    const release = vi.spyOn(await import("@worker/handlers/dispatch.js"), "releaseRunHold");
    const job = { name, finishedOn: Date.now(), data: name === "deliver-mini-tool-results" ? { taskId: f.taskId, deliveryVersion: 1 } : {} };
    expect(await cleanupFailedJobNodes(getStreamRedis(), job as unknown as Parameters<typeof cleanupFailedJobNodes>[1], "fixture stalled delivery")).toBe(0);
    expect(release).not.toHaveBeenCalled();
    expect(await deliveryState(f)).toEqual(pending(f)); expect(await invariants(f)).toEqual(before); expect(await events(f)).toEqual([]);
    expect([...await pg`SELECT status,node_history_id FROM node_tasks WHERE task_id=${f.taskId}`]).toEqual([{ status: "running", node_history_id: null }]);
    expect([...await pg`SELECT id FROM node_history WHERE task_id=${f.taskId}`]).toEqual([]);
  });
});
