// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Real SQL registration, history, node-task settlement and Redis publication for inner#1306. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getNodeTaskConfig, getStreamRedis, initCore, initLogger, loadLocales, logger, taskEventsStreamKey } from "@breatic/core";
import type { MiniToolExecutionCompletion } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import { finishMiniToolExecutionAndNotify } from "@worker/handlers/mini-tool/execution-completion.js";
import * as backendUpload from "@worker/handlers/backend-upload.js";
import { executionSnapshot, seedExecution, type ExecutionFixture } from "../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";

let pg: ReturnType<typeof createPgClient>;
let yjsPg: ReturnType<typeof createPgClient>;

beforeAll(() => {
  // The injected addresses belong to this suite's fresh containers, not a dev stack.
  // A different allowed ENV keeps this file's stream prefix separate as well.
  initCore({ ...process.env, ENV: "staging", PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1", UPLOAD_BASE_URL: "https://assets.example.test" });
  loadLocales(); initLogger("planned-publication-fixture");
  pg = createPgClient(inject("DATABASE_URL"), { name: "planned-publication-sql", max: 4 });
  yjsPg = createPgClient(inject("YJS_DATABASE_URL"), { name: "planned-publication-yjs", max: 1 });
});
beforeEach(() => {
  // Network tripwires return no fake media. Any accidental computation or transfer
  // fails locally and is also rejected by the zero-call assertion after each case.
  vi.spyOn(backendUpload, "storeFromUrl").mockRejectedValue(new Error("Publication must not transfer media"));
});
afterEach(() => {
  try {
    expect(backendUpload.storeFromUrl).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
afterAll(async () => { await pg.end(); await yjsPg.end(); initCore(process.env); });

/** Seed only real accepted SQL facts and the task row on the original output target.
 * @throws {Error} When fixture persistence fails.
 */
async function fixture(status: "running" | "failed" | "expired" = "running"): Promise<ExecutionFixture> {
  const f = await seedExecution(pg, "running");
  const startedAt = new Date(Date.now() - (status === "expired" ? getNodeTaskConfig().default_budget_ms + 1 : 0));
  if (status === "expired") await pg`UPDATE tasks SET created_at=${startedAt} WHERE id=${f.taskId}`;
  await pg`INSERT INTO node_tasks (project_id,space_id,node_id,kind,action,status,started_by_user_id,budget_ms,label,task_id,started_at,settled_at)
    VALUES (${f.projectId},${f.plan.spaceId},${f.plan.outputs[0]!.nodeId},'generation','mini_tool',${status},${f.userId},${getNodeTaskConfig().default_budget_ms},'publication',${f.taskId},${startedAt},${status === "running" ? null : new Date()})`;
  await pg`INSERT INTO node_history (project_id,node_id,user_id,entry_type,status,content)
    VALUES (${f.projectId},${f.plan.draft.source.nodeId},${f.userId},'upload','success',${f.plan.binding.canonicalURL})`;
  return f;
}

/** Supply the one approved remove-background slot, without an invented sibling output.
 * @throws {never} Never.
 */
function completion(f: ExecutionFixture): MiniToolExecutionCompletion {
  return { planFingerprint: f.plan.planFingerprint, expectedVersion: 0,
    outputs: [{ ...f.plan.outputs[0]!, result: structuredClone(f.registered) }], error: null };
}

/** Observe the complete source history independently from the publication owner.
 * @throws {Error} When fixture queries fail.
 */
async function sourceHistory(f: ExecutionFixture): Promise<unknown[]> {
  return [...await pg`SELECT * FROM node_history WHERE project_id=${f.projectId} AND node_id=${f.plan.draft.source.nodeId} ORDER BY id`];
}

/** Read actual stream payload bytes for this original target; never mock the publisher.
 * @throws {Error} When Redis or a stored JSON payload is invalid.
 */
async function events(f: ExecutionFixture): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const entries = await getStreamRedis().xrange(taskEventsStreamKey(), "-", "+");
  return entries.flatMap(([id, fields]) => {
    const offset = fields.indexOf("payload");
    if (offset < 0 || fields[offset + 1] === undefined) throw new Error("Fixture stream entry has no payload");
    const decoded: unknown = JSON.parse(fields[offset + 1]!);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Fixture stream payload is not an object");
    const payload = decoded as Record<string, unknown>;
    return payload.nodeId === f.plan.outputs[0]!.nodeId ? [{ id, payload }] : [];
  });
}

/** Assert the exact media and top-level logical identity from the original SQL fixture.
 * @throws {Error} When any observed event differs from the adopted identity contract.
 */
function expectMediaEvent(payload: Record<string, unknown>, f: ExecutionFixture): void {
  expect(payload).toEqual({ type: "node-task-counts", docName: canvasSpaceDocName(f.projectId, f.plan.spaceId), nodeId: f.plan.outputs[0]!.nodeId,
    counts: { running: 0, waiting: 0, done: 1, failed: 0, expired: 0 },
    result: { content: f.registered.canonicalURL, coverUrl: null, width: 960, height: 540, duration: 5.013, mimeType: "video/webm", size: 1588436 },
    resultOrigin: { kind: "mini-tool-output", runId: f.taskId, planFingerprint: f.plan.planFingerprint, outputIndex: 0 } });
}

/** Verify canonical history, unchanged SQL source and absent backend-created Yjs state.
 * @throws {Error} When SQL observations differ from the original registered facts.
 */
async function expectPersistence(f: ExecutionFixture, originalSourceHistory: unknown[], status: "done" | "failed" | "expired"): Promise<string> {
  const history = await pg<{ id: string; content: string; status: string; task_id: string; width: number; height: number; duration: string; mime_type: string; size: string }[]>`
    SELECT id,content,status,task_id,media_width AS width,media_height AS height,duration_seconds::text AS duration,mime_type,size_bytes::text AS size
    FROM node_history WHERE task_id=${f.taskId} ORDER BY id`;
  expect(history).toHaveLength(1);
  const entry = history[0]!;
  expect(entry).toEqual({ id: entry.id, content: f.registered.canonicalURL, status: "success", task_id: f.taskId, width: 960, height: 540, duration: "5.013", mime_type: "video/webm", size: "1588436" });
  const rows = await pg`SELECT node_id,status,node_history_id FROM node_tasks WHERE task_id=${f.taskId}`;
  expect([...rows]).toEqual([{ node_id: f.plan.outputs[0]!.nodeId, status, node_history_id: entry.id }]);
  const assets = await pg`SELECT id,file_url,content_hash FROM studio_assets WHERE generation_task_id=${f.taskId}`;
  expect([...assets]).toEqual([{ id: f.registered.assetId, file_url: f.registered.canonicalURL, content_hash: f.registered.contentHash }]);
  expect(await sourceHistory(f)).toEqual(originalSourceHistory);
  expect([...await yjsPg`SELECT name FROM yjs_documents WHERE name=${canvasSpaceDocName(f.projectId, f.plan.spaceId)}`]).toEqual([]);
  expect([...await pg`SELECT id FROM task_upstream_steps WHERE task_id=${f.taskId}`]).toEqual([]);
  expect((await executionSnapshot(pg, f)).params).toEqual({ miniToolExecution: f.plan });
  return entry.id;
}

describe("planned publication keeps SQL output identity across real Redis entries", () => {
  it("P01 publishes the original SQL run, plan and registered slot at the event top level", async () => {
    const f = await fixture(); const source = await sourceHistory(f);
    const [stored] = await pg`SELECT params FROM tasks WHERE id=${f.taskId}`;
    expect(stored).toEqual({ params: { miniToolExecution: f.plan } });
    const finished = await finishMiniToolExecutionAndNotify(f.taskId, completion(f), getStreamRedis());
    expect(finished.record).toMatchObject({ runId: f.taskId, planFingerprint: f.plan.planFingerprint, status: "completed", resultVersion: 1,
      outputs: [{ ...f.plan.outputs[0], result: f.registered }] });
    const actual = await events(f); expect(actual).toHaveLength(1);
    expect(actual[0]!.id).toMatch(/^\d+-\d+$/);
    expectMediaEvent(actual[0]!.payload, f);
    await expectPersistence(f, source, "done");
  });

  // Contract change (design §7.11, §10.8 失败与提交; round 4, user 2026-11-05): the terminal commit delivers only positions still
  // pending, so a replayed terminal finds the slot published and delivers nothing again; the node keeps the delivered result.
  it("P02 a terminal replay delivers nothing again: one transport entry, the delivered node result and its history unchanged", async () => {
    const f = await fixture(); const source = await sourceHistory(f);
    const first = await finishMiniToolExecutionAndNotify(f.taskId, completion(f), getStreamRedis());
    const firstHistory = await expectPersistence(f, source, "done");
    const delivered = await events(f); expect(delivered).toHaveLength(1);
    expectMediaEvent(delivered[0]!.payload, f);
    const held = await executionSnapshot(pg, f);
    expect((held.result.miniToolDelivery as { outputs: { outputIndex: number; state: string }[] }).outputs).toEqual([{ outputIndex: 0, state: "published" }]);
    const replay = { planFingerprint: first.record.planFingerprint, expectedVersion: first.record.resultVersion,
      outputs: structuredClone(first.record.outputs), error: first.record.error };
    const second = await finishMiniToolExecutionAndNotify(f.taskId, replay, getStreamRedis());
    expect(second.record).toEqual(first.record);
    expect(await executionSnapshot(pg, f)).toEqual(held);
    // No second delivery event: the stream still holds only the first entry for this node.
    expect(await events(f)).toEqual(delivered);
    expect(await expectPersistence(f, source, "done")).toBe(firstHistory);
  });

  it("P05 recovers a real first XADD failure from the saved canonical result without provider or transfer", async () => {
    const f = await fixture(); const source = await sourceHistory(f); const redis = getStreamRedis();
    const key = taskEventsStreamKey(); const originalType = await redis.type(key);
    const backup = `${key}:publication-fixture:${randomUUID()}`; const fault = `wrong-type-${randomUUID()}`;
    const errors = vi.spyOn(logger, "error");
    let first: Awaited<ReturnType<typeof finishMiniToolExecutionAndNotify>> | undefined;
    if (originalType !== "none") await redis.rename(key, backup);
    try {
      await redis.set(key, fault);
      first = await finishMiniToolExecutionAndNotify(f.taskId, completion(f), redis);
      expect(first.record).toMatchObject({ status: "completed", resultVersion: 1, outputs: [{ result: f.registered }] });
      expect(await redis.type(key)).toBe("string"); expect(await redis.get(key)).toBe(fault);
      expect(errors.mock.calls).toEqual(expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ err: expect.objectContaining({ message: expect.stringContaining("WRONGTYPE") }) })])]));
    } finally {
      await redis.del(key);
      if (originalType !== "none") await redis.rename(backup, key);
    }
    expect(await redis.type(key)).toBe(originalType);
    expect(await redis.exists(backup)).toBe(0);
    expect(await events(f)).toEqual([]);
    const firstHistory = await expectPersistence(f, source, "done");
    if (first === undefined) throw new Error("The first completion did not return its committed result");
    const held = await executionSnapshot(pg, f);
    const pendingDelivery = { schemaVersion: 1, planFingerprint: f.plan.planFingerprint, version: 1,
      outputs: [{ outputIndex: 0, state: "pending" }], lastErrorCode: "delivery_publish_failed" };
    expect(held.result.miniToolDelivery).toEqual(pendingDelivery);
    const recovered = await finishMiniToolExecutionAndNotify(f.taskId, { planFingerprint: first.record.planFingerprint,
      expectedVersion: first.record.resultVersion, outputs: structuredClone(first.record.outputs), error: first.record.error }, redis);
    expect(recovered.record).toEqual(first.record);
    const after = await executionSnapshot(pg, f);
    const publishedDelivery = { schemaVersion: 1, planFingerprint: f.plan.planFingerprint, version: 2,
      outputs: [{ outputIndex: 0, state: "published" }], lastErrorCode: null };
    expect(after.result.miniToolDelivery).toEqual(publishedDelivery);
    expect(after).toEqual({ status: held.status, params: held.params,
      result: { ...held.result, miniToolDelivery: publishedDelivery },
      started_at: held.started_at, completed_at: held.completed_at, billed_at: held.billed_at,
      billed_credits: held.billed_credits, error_message: held.error_message });
    const actual = await events(f); expect(actual).toHaveLength(1); expectMediaEvent(actual[0]!.payload, f);
    expect(await expectPersistence(f, source, "done")).toBe(firstHistory);
  });

  it.each(["failed", "expired"] as const)("P13 keeps an already %s node task terminal and publishes only counts for late canonical media", async (status) => {
    const f = await fixture(status); const source = await sourceHistory(f);
    const [before] = await pg`SELECT id,status,settled_at::text AS settled_at FROM node_tasks WHERE task_id=${f.taskId}`;
    await finishMiniToolExecutionAndNotify(f.taskId, completion(f), getStreamRedis());
    const actual = await events(f); expect(actual).toHaveLength(1);
    expect(actual[0]!.payload).toEqual({ type: "node-task-counts", docName: canvasSpaceDocName(f.projectId, f.plan.spaceId), nodeId: f.plan.outputs[0]!.nodeId,
      counts: { running: 0, waiting: 0, done: 0, failed: status === "failed" ? 1 : 0, expired: status === "expired" ? 1 : 0 } });
    expect(actual[0]!.payload).not.toHaveProperty("result"); expect(actual[0]!.payload).not.toHaveProperty("resultOrigin");
    await expectPersistence(f, source, status);
    expect([...await pg`SELECT id,status,settled_at::text AS settled_at FROM node_tasks WHERE task_id=${f.taskId}`]).toEqual([before]);
  });
});
