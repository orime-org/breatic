// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore, loadLocales } from "@breatic/core";
import type { MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import {
  miniToolExecutionService, runningSlotService, upstreamStepRepo, recordMiniToolStepResult, recordMiniToolConsumption,
  openMiniToolConsumption, completeMiniToolConsumptionSet, settleMiniToolCharge,
} from "@domain/index.js";
import { executionSnapshot, seedExecution, storeExecutionFixture, type ExecutionFixture } from "./execution-lifecycle-fixtures.js";
import {
  EXECUTION_ERROR as ERROR, claimExecutionSettlement, confirmExecutionCost, executionCompletion, executionIdentity,
  publicExecutionRecord, terminalExecution,
} from "./execution-step-fixtures.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

let pg: ReturnType<typeof createPgClient>;
beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1" }); loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "execution-lifecycle", max: 8 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

const completion = executionCompletion;
const identity = executionIdentity;
const terminal = (f: ExecutionFixture, failed = false): Promise<MiniToolExecutionRecord> => terminalExecution(pg, f, failed);
const publicRecord = (f: ExecutionFixture): Promise<MiniToolExecutionRecord> => publicExecutionRecord(pg, f);
const claim = (f: ExecutionFixture): ReturnType<typeof claimExecutionSettlement> => claimExecutionSettlement(pg, f);
/** Persist the original container job's done result and its canonical receipt before a late delivery.
 * @throws {Error} When a real result or receipt write fails.
 */
async function returned(f: ExecutionFixture): Promise<void> {
  const i = await identity(f);
  await recordMiniToolStepResult({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, outcome: "done", result: { state: "done" } },
    { kind: "container_job", parse: () => ({ state: "done" }) });
  await upstreamStepRepo.recordInline(i.stepId, { "miniToolAsset:0": f.registered.assetId }, 0);
}
/** Retain the complete independent DB snapshot across an injected transaction failure.
 * @throws {Error} On a fixture SQL failure.
 */
async function financialSnapshot(f: ExecutionFixture, stepId: string): Promise<unknown> {
  const [step] = await pg`SELECT to_jsonb(s) AS value FROM task_upstream_steps s WHERE id=${stepId}`;
  const usage = await pg`SELECT operation_key,cost_usd::text FROM agent_usage_records WHERE operation_key IN (SELECT output#>>'{miniToolConsumption,consumptionKey}' FROM task_upstream_steps WHERE task_id=${f.taskId})`;
  return { parent: await executionSnapshot(pg, f), step, usage: [...usage] };
}
/** Reject exactly this parent's namespace, settlement, usage or step write, using a real PG trigger.
 * @throws {Error} When trigger setup, the operation or cleanup fails.
 */
async function rejectWrite(f: ExecutionFixture, point: "public" | "settlement" | "usage" | "step", operation: () => Promise<unknown>): Promise<void> {
  const table = point === "usage" ? "agent_usage_records" : point === "step" ? "task_upstream_steps" : "tasks";
  const condition = point === "public" ? `NEW.id='${f.taskId}'::uuid AND NEW.result->'miniToolExecution' IS DISTINCT FROM OLD.result->'miniToolExecution'`
    : point === "settlement" ? `NEW.id='${f.taskId}'::uuid AND NEW.result->'settlement' IS DISTINCT FROM OLD.result->'settlement'`
      : point === "usage" ? `NEW.operation_key IN (SELECT output#>>'{miniToolConsumption,consumptionKey}' FROM task_upstream_steps WHERE task_id='${f.taskId}'::uuid)` : `NEW.task_id='${f.taskId}'::uuid`;
  await pg.unsafe(`CREATE FUNCTION reject_execution_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'fixture_execution_write_failed'; END IF; RETURN NEW; END $$`);
  await pg.unsafe(`CREATE TRIGGER reject_execution_write BEFORE ${point === "usage" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_execution_write()`);
  try { await operation(); } finally {
    await pg.unsafe(`DROP TRIGGER reject_execution_write ON ${table}`); await pg.unsafe("DROP FUNCTION reject_execution_write()");
  }
}

describe("planned lifecycle start and complete media-index transaction (W15/M)", () => {
  it("W01/W15 initializes every slot before returning SQL context and preserves first startedAt", async () => {
    const f = await seedExecution(pg, "pending", false);
    // The running-task gate starts a pending task (inner#1968 design 3.9); the pickup runs after it.
    await pg`UPDATE tasks SET status='running',started_at=clock_timestamp() WHERE id=${f.taskId}`;
    const first = await miniToolExecutionService.startMiniToolExecution(f.taskId, "original-job");
    expect(first.execution).toEqual(f.plan); expect(first.task).toMatchObject({ id: f.taskId, userId: f.userId, status: "running" });
    expect(first.record).toEqual({ ...f.record, status: "running" }); const before = await executionSnapshot(pg, f);
    expect(before.result).toEqual({ preserved: { token: "original" }, miniToolExecution: { ...f.record, status: "running" } });
    expect(before.started_at).toEqual(expect.any(String));
    await miniToolExecutionService.startMiniToolExecution(f.taskId, "second-job"); expect((await executionSnapshot(pg, f)).started_at).toBe(before.started_at);
  });
  it("W15 rolls back running and namespace together when initialization persistence fails", async () => {
    const f = await seedExecution(pg, "pending", false);
    // The running-task gate starts a pending task (inner#1968 design 3.9); the pickup runs after it.
    await pg`UPDATE tasks SET status='running',started_at=clock_timestamp() WHERE id=${f.taskId}`;
    const before = await executionSnapshot(pg, f);
    await rejectWrite(f, "public", async () => { await expect(miniToolExecutionService.startMiniToolExecution(f.taskId, "job")).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["model", "credits", "project", "space", "task", "targets"])("W02/W03 rejects frozen-parent mismatch %s without writes", async (field) => {
    const f = await seedExecution(pg); const plan = structuredClone(f.plan);
    if (field === "model") await pg`UPDATE tasks SET model='different-model' WHERE id=${f.taskId}`;
    else {
      if (field === "credits") plan.credits += 1;
      else if (field === "project") plan.projectId = randomUUID();
      else if (field === "space") plan.spaceId = randomUUID();
      else if (field === "task") plan.taskId = randomUUID();
      else plan.targetNodeIds = [randomUUID()];
      await pg`UPDATE tasks SET params=${pg.json({ miniToolExecution: { ...plan } })} WHERE id=${f.taskId}`;
    }
    const before = await executionSnapshot(pg, f); await expect(miniToolExecutionService.startMiniToolExecution(f.taskId, "job")).rejects.toBeInstanceOf(Error); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("M02 publishes version1 using original target, recipe and actual winner while preserving siblings", async () => {
    const f = await seedExecution(pg, "running"); const result = await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f));
    // The run made no call, so the terminal commit closes its empty consumption set and settlement waits.
    expect(result.record).toEqual({ ...f.record, status: "completed", resultVersion: 1, billingState: "waiting", outputs: completion(f).outputs });
    const row = await executionSnapshot(pg, f); expect(row.status).toBe("completed"); expect(row.result.preserved).toEqual({ token: "original" });
    expect(result.record.sourceBindings[0]!.mediaInfo.duration).toBe(5.055); expect(result.record.outputs[0]!.result).toEqual(f.registered);
  });
  it("M03 replays identical media without version inflation or sibling changes", async () => {
    const f = await seedExecution(pg); const r = await terminal(f);
    // The first replay closes the run's empty consumption set; media stays as committed.
    const closed = (await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f))).record; expect(closed).toEqual({ ...r, billingState: "waiting" });
    const before = await executionSnapshot(pg, f);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f))).record).toEqual(closed); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["missing", "extra", "node", "recipe", "plan"])("M04 rejects %s in the complete stable index", async (bad) => {
    const f = await seedExecution(pg, "running"); const c = completion(f);
    if (bad === "missing") c.outputs = []; else if (bad === "extra") c.outputs.push({ ...c.outputs[0]!, outputIndex: 1, nodeId: randomUUID() });
    else if (bad === "node") c.outputs[0]!.nodeId = randomUUID();
    else if (bad === "recipe") Object.assign(c.outputs[0]!.recipe, { kind: "frame" }); else c.planFingerprint = "e".repeat(64);
    const before = await executionSnapshot(pg, f); await expect(miniToolExecutionService.finishMiniToolExecution(f.taskId, c)).rejects.toBeInstanceOf(Error); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("M05 retains first canonical success when another registered asset contradicts it", async () => {
    const f = await seedExecution(pg); await terminal(f); const before = await executionSnapshot(pg, f); const c = completion(f, false, 1);
    c.outputs[0]!.result = { ...f.registered, assetId: randomUUID(), contentHash: "e".repeat(64), canonicalURL: "https://assets.example.test/video/other.webm" };
    await expect(miniToolExecutionService.finishMiniToolExecution(f.taskId, c)).rejects.toBeInstanceOf(Error); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  // frames-split §7.19: a run is one whole; once it failed, nothing is registered onto it late.
  it("M06 refuses registered media on a failed run without a write", async () => {
    const f = await seedExecution(pg); await returned(f); await terminal(f, true); const before = await executionSnapshot(pg, f);
    await expect(miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false, 1))).rejects.toBeInstanceOf(Error);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("M06 refuses a failed completion that still carries a registered output", async () => {
    const f = await seedExecution(pg, "running"); const before = await executionSnapshot(pg, f);
    await expect(miniToolExecutionService.finishMiniToolExecution(f.taskId, { ...completion(f), error: ERROR })).rejects.toBeInstanceOf(Error);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["completed", "failed"] as const)("W15 repeats start on %s without erasing original fees, media or siblings", async (failedStatus) => {
    const f = await seedExecution(pg); const r = await terminal(f, failedStatus === "failed");
    r.usage = [{ consumptionKey: "c".repeat(64), state: "known", chargeTo: "user", costUsd: 0.3, credits: null }]; await storeExecutionFixture(pg, f, r);
    const before = await executionSnapshot(pg, f); expect((await miniToolExecutionService.startMiniToolExecution(f.taskId, "replay")).record.usage).toEqual(r.usage); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("M12 start replays cancelled unchanged and does not begin a new computation", async () => {
    const f = await seedExecution(pg, "cancelled"); const before = await executionSnapshot(pg, f);
    expect((await miniToolExecutionService.startMiniToolExecution(f.taskId, "late-job")).record.status).toBe("cancelled"); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
});

describe("step-owned actual consumption public mirror transaction (U/B)", () => {
  it("U01 mirrors first identity and same-ID replay as exactly one pending item", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f);
    const expected = { consumptionKey: i.key, state: "pending", chargeTo: "user", costUsd: null, credits: null };
    expect((await publicRecord(f)).usage).toEqual([expected]);
    await identity(f); expect((await publicRecord(f)).usage).toEqual([expected]);
  });
  it("U01 also mirrors a container step's consumption from the generic producer within its own transaction", async () => {
    const f = await seedExecution(pg, "running"); const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "container_job", endpoint: "MiniToolContainerStd1", itemIndex: 0 }]); if (!s) throw new Error("Missing fixture step");
    const upstream = { kind: "container" as const, containerClass: "MiniToolContainerStd1", jobId: `task:${f.taskId}:chunk:0`, chunkIndex: 0 };
    const c = await openMiniToolConsumption({ taskId: f.taskId, stepId: s.id, identity: upstream, chargeTo: "user", creditMultiplier: 1, containerPricing: { configVersion: "cloudflare-2026-10-07", size: { vcpu: 0.5, memory_gib: 4, disk_gb: 8 }, prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 } } });
    expect((await publicRecord(f)).usage).toEqual([{ consumptionKey: c.consumptionKey, state: "pending", chargeTo: "user", costUsd: null, credits: null }]);
  });
  it("U01 rolls a container step's consumption and cycle back if the public pending write fails", async () => {
    const f = await seedExecution(pg, "running"); const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "container_job", endpoint: "MiniToolContainerStd1", itemIndex: 0 }]); if (!s) throw new Error("Missing fixture step");
    const before = await financialSnapshot(f, s.id);
    await rejectWrite(f, "public", async () => { await expect(openMiniToolConsumption({ taskId: f.taskId, stepId: s.id, identity: { kind: "container", containerClass: "MiniToolContainerStd1", jobId: `task:${f.taskId}:chunk:0`, chunkIndex: 0 }, chargeTo: "user", creditMultiplier: 1, containerPricing: { configVersion: "cloudflare-2026-10-07", size: { vcpu: 0.5, memory_gib: 4, disk_gb: 8 }, prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 } } })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await financialSnapshot(f, s.id)).toEqual(before);
  });
  it("U02 confirms known in both owners before usage recording and without media version changes", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmExecutionCost(f, i, c.claim, 0.3);
    expect((await publicRecord(f)).usage).toEqual([{ consumptionKey: i.key, state: "known", chargeTo: "user", costUsd: 0.3, credits: null }]); expect((await publicRecord(f)).resultVersion).toBe(0);
    const [count] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key=${i.key}`; expect(count).toEqual({ count: 0 });
  });
  it("U03 rolls known back to pending if the public mirror update fails", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f); const before = await financialSnapshot(f, i.stepId);
    await rejectWrite(f, "public", async () => { await expect(confirmExecutionCost(f, i, c.claim, 0.3)).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await financialSnapshot(f, i.stepId)).toEqual(before);
  });
  it("U04 records the container job's actual expense and its public credits exactly once", async () => {
    const chargeTo = "user"; const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmExecutionCost(f, i, c.claim, 0.3);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim });
    const expected = [{ consumptionKey: i.key, state: "recorded", chargeTo, costUsd: 0.3, credits: 30 }];
    expect((await publicRecord(f)).usage).toEqual(expected);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity }); expect((await publicRecord(f)).usage).toEqual(expected);
    const [count] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key=${i.key}`; expect(count).toEqual({ count: 1 });
  });
  it.each(["usage", "step", "public", "settlement"] as const)("U05 rolls all record writes back at %s", async (point) => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmExecutionCost(f, i, c.claim, 0.3);
    const before = await financialSnapshot(f, i.stepId);
    await rejectWrite(f, point, async () => { await expect(recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await financialSnapshot(f, i.stepId)).toEqual(before);
  });
  it("U06 ignores an expired claim without changing mirrored pending or media", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f); const before = await executionSnapshot(pg, f);
    await confirmExecutionCost(f, i, { ...c.claim, leaseToken: "stale-token" }, 999);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("U08/U09 keeps registered output readable while billing remains pending and the hold is held", async () => {
    const f = await seedExecution(pg, "running"); await identity(f); await terminal(f);
    await pg`INSERT INTO credit_holds (studio_id,actor_user_id,reference_id,amount,status,expires_at) VALUES (${f.studioId},${f.userId},${f.taskId},30,'held','2099-01-01T00:00:00Z')`;
    const r = (await miniToolExecutionService.readMiniToolExecution(f.taskId)).record; expect(r.outputs[0]!.result).toEqual(f.registered); expect(r.billingState).toBe("waiting");
    expect(await settleMiniToolCharge(f.taskId)).toEqual({ state: "pending" }); const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
  });
  it("U10 settles a closed recorded task once while retaining the media and public fees", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmExecutionCost(f, i, c.claim, 0.3);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim }); await terminal(f); await completeMiniToolConsumptionSet(f.taskId);
    const first = await settleMiniToolCharge(f.taskId); expect(first).toMatchObject({ state: "settled", credits: 30, first: true });
    expect(await settleMiniToolCharge(f.taskId)).toMatchObject({ state: "settled", credits: 30, first: false });
    const r = (await miniToolExecutionService.readMiniToolExecution(f.taskId)).record; expect(r).toMatchObject({ status: "completed", resultVersion: 1, billingState: "settled", usage: [{ consumptionKey: i.key, state: "recorded", chargeTo: "user", costUsd: 0.3, credits: 30 }] }); expect(r.outputs[0]!.result).toEqual(f.registered);
  });
  it("B04 permits recorded actual expense beside an active idle cycle", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmExecutionCost(f, i, c.claim, 0.3);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim });
    const r = (await miniToolExecutionService.readMiniToolExecution(f.taskId)).record; expect(r).toMatchObject({ status: "running", resultVersion: 0, billingState: "idle", usage: [{ consumptionKey: i.key, state: "recorded", costUsd: 0.3, credits: 30 }] });
  });
  it("U11 completing the call set preserves the actual live checking lease and media", async () => {
    const f = await seedExecution(pg, "running"); await identity(f); const c = await claim(f); await terminal(f); const before = await executionSnapshot(pg, f);
    const period = await completeMiniToolConsumptionSet(f.taskId); expect(period).toMatchObject({ version: c.claim.version, state: "checking", leaseToken: c.claim.leaseToken, leaseUntil: c.leaseUntil, consumptionSetComplete: true });
    expect((await executionSnapshot(pg, f)).result.miniToolExecution).toEqual(before.result.miniToolExecution);
  });
  it("B01 builds active0 from accepted F without writing on a read", async () => {
    const f = await seedExecution(pg, "pending", false); const before = await executionSnapshot(pg, f);
    expect((await miniToolExecutionService.readMiniToolExecution(f.taskId)).record).toEqual(f.record); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["idle", "waiting", "checking", "settled"] as const)("B03 reads the actual %s period without a steps lookup", async (state) => {
    const f = await seedExecution(pg); await pg`UPDATE tasks SET result=result || ${pg.json({ settlement: { version: 1, state, pendingConsumptionKeys: [], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: false } })} WHERE id=${f.taskId}`;
    expect(((await miniToolExecutionService.readMiniToolExecution(f.taskId)).record).billingState).toBe(state);
  });
  it("B05 refuses damaged persisted settlement instead of treating it as absent", async () => {
    const f = await seedExecution(pg); await pg`UPDATE tasks SET result=result || ${pg.json({ settlement: { state: "broken" } })} WHERE id=${f.taskId}`;
    await expect(miniToolExecutionService.readMiniToolExecution(f.taskId)).rejects.toBeInstanceOf(Error);
  });
});

// frames-split §7.19 提交点: once every output is reported, the run writes its commit point under the execution record lock,
// in three cases: a running record without one takes it; a record that has one keeps it and goes on registering; any
// other state stops. Past it, only the completed commit of every registered output ends the run, and the failure exits
// refuse it.
describe("the commit point (frames-split §7.19)", () => {
  type Marked = { state: "committed" | "ended"; record: MiniToolExecutionRecord };
  /** The new entry, read at call time so its absence fails each case on its own. @returns It. */
  function mark(): (taskId: string) => Promise<Marked> {
    const fn = (miniToolExecutionService as unknown as Record<string, unknown>).markMiniToolExecutionCommitPoint;
    expect(fn, "markMiniToolExecutionCommitPoint is exported from the execution service").toBeTypeOf("function");
    return fn as (taskId: string) => Promise<Marked>;
  }
  /** The stored commit point. @returns It, or undefined. */
  async function stored(f: ExecutionFixture): Promise<unknown> {
    return ((await executionSnapshot(pg, f)).result.miniToolExecution as Record<string, unknown>).commitPoint;
  }

  it("CP01 a running record takes its commit point while the task row stays running", async () => {
    const f = await seedExecution(pg, "running");
    const marked = await mark()(f.taskId);
    expect(marked.state).toBe("committed");
    expect(marked.record).toEqual({ ...f.record, status: "running", commitPoint: expect.any(String) });
    expect(Number.isNaN(Date.parse(marked.record.commitPoint!))).toBe(false);
    const row = await executionSnapshot(pg, f);
    expect({ status: row.status, completed_at: row.completed_at, error_message: row.error_message }).toEqual({ status: "running", completed_at: null, error_message: null });
    expect(await stored(f)).toBe(marked.record.commitPoint);
  });

  it("CP02 a record past its commit point keeps it and goes on registering", async () => {
    const f = await seedExecution(pg, "running"); const first = await mark()(f.taskId); const before = await executionSnapshot(pg, f);
    const again = await mark()(f.taskId);
    expect(again).toEqual(first);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });

  it.each(["failed", "cancelled", "completed"] as const)("CP03 a %s run takes no commit point and writes nothing", async (status) => {
    const f = await seedExecution(pg, "running"); if (status === "completed") await terminal(f); else await terminal(f, true);
    if (status === "cancelled") await pg`UPDATE tasks SET status='cancelled' WHERE id=${f.taskId}`;
    const before = await executionSnapshot(pg, f);
    expect((await mark()(f.taskId)).state).toBe("ended");
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });

  it("CP04 a pending run takes no commit point", async () => {
    const f = await seedExecution(pg, "pending"); const before = await executionSnapshot(pg, f);
    expect((await mark()(f.taskId)).state).toBe("ended");
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });

  it("CP05 past the commit point the completed commit of every registered output ends the run and drops the commit point", async () => {
    const f = await seedExecution(pg, "running"); await mark()(f.taskId);
    const { record } = await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f));
    expect(record).toMatchObject({ status: "completed", resultVersion: 1, error: null, outputs: completion(f).outputs });
    expect(record).not.toHaveProperty("commitPoint");
    const row = await executionSnapshot(pg, f);
    expect(row.status).toBe("completed"); expect(row.completed_at).toEqual(expect.any(String));
  });

  it("CP06 past the commit point a failed commit is refused without a write", async () => {
    const f = await seedExecution(pg, "running"); await mark()(f.taskId); const before = await executionSnapshot(pg, f);
    await expect(miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, true))).rejects.toBeInstanceOf(Error);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });

  it("CP07 past the commit point an admission failure is refused without a write", async () => {
    const f = await seedExecution(pg, "running"); await mark()(f.taskId); const before = await executionSnapshot(pg, f);
    await expect(miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, ERROR)).rejects.toBeInstanceOf(Error);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });

  it("CP08 past the commit point failing the task outside the run is refused and rolled back", async () => {
    const f = await seedExecution(pg, "running"); await mark()(f.taskId); const before = await executionSnapshot(pg, f);
    await expect(runningSlotService.failTask(f.taskId, "internal")).rejects.toBeInstanceOf(Error);
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });

  it("CP09 concurrent commit points under the record lock agree on one instant", async () => {
    const f = await seedExecution(pg, "running"); const commit = mark();
    let release!: () => void; let entered!: () => void; const gate = new Promise<void>((r) => { release = r; }); const ready = new Promise<void>((r) => { entered = r; });
    const owner = pg.begin(async (tx) => { await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; entered(); await gate; }); await ready;
    const a = commit(f.taskId); const b = commit(f.taskId); void a.catch(() => undefined); void b.catch(() => undefined);
    try {
      await waitUntilBlockedOn(pg, ["tasks", "for update"], 2); release(); await owner;
      const [x, y] = await Promise.all([a, b]);
      expect([x.state, y.state]).toEqual(["committed", "committed"]); expect(x.record.commitPoint).toBe(y.record.commitPoint);
    } finally { release(); await owner; await Promise.allSettled([a, b]); }
  });

  it("CP10 the execution service no longer takes a per-output progress commit", () => {
    expect((miniToolExecutionService as unknown as Record<string, unknown>).commitMiniToolExecutionProgress).toBeUndefined();
  });
});

// frames-split §7.19 授权作废与对象回收: every terminal voids what is left of the run's unconsumed output grants in its own
// transaction; a consumed grant stays consumed.
describe("output grants at the run's end (frames-split §7.19)", () => {
  /** Seed one output grant of the run. @returns Its key. */
  async function grant(f: ExecutionFixture, consumed = false): Promise<string> {
    const key = `video/grant/${randomUUID()}.mp4`;
    await pg`INSERT INTO upload_grants (user_id,studio_id,storage_key,declared_size,expires_at,project_id,generation_task_id,consumed_at)
      VALUES (${f.userId},${f.studioId},${key},1,now() + interval '2 hours',${f.projectId},${f.taskId},${consumed ? pg`now()` : null})`;
    return key;
  }
  /** One grant's terminal fields. @returns Them. */
  async function state(key: string): Promise<{ voided: boolean; consumed: boolean; reason: string | null }> {
    const [row] = await pg<{ voided: boolean; consumed: boolean; reason: string | null }[]>`
      SELECT voided_at IS NOT NULL AS voided, consumed_at IS NOT NULL AS consumed, failure_reason AS reason FROM upload_grants WHERE storage_key=${key}`;
    return row!;
  }

  it.each([[false, "completed"], [true, "failed"]] as const)("GV01 a run ending %s voids its unconsumed grants and keeps the consumed one", async (failed, status) => {
    const f = await seedExecution(pg, "running"); const open = await grant(f); const used = await grant(f, true);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, failed))).record.status).toBe(status);
    expect(await state(open)).toMatchObject({ voided: true, consumed: false });
    expect(await state(used)).toEqual({ voided: false, consumed: true, reason: null });
  });

  it("GV02 an admission failure voids the run's unconsumed grants", async () => {
    const f = await seedExecution(pg, "running"); const open = await grant(f);
    await miniToolExecutionService.failMiniToolExecutionAdmission(f.taskId, ERROR);
    expect(await state(open)).toMatchObject({ voided: true });
  });

  it.each(["cancel", "fail"] as const)("GV03 a waiting run ended outside the worker (%s) voids its unconsumed grants", async (how) => {
    const f = await seedExecution(pg, "pending"); const open = await grant(f);
    if (how === "cancel") await runningSlotService.cancelQueued(f.taskId); else await runningSlotService.failTask(f.taskId, "internal");
    expect(await state(open)).toMatchObject({ voided: true });
  });

  it("GV04 a grant of another task is untouched", async () => {
    const f = await seedExecution(pg, "running"); const other = await seedExecution(pg, "running"); const theirs = await grant(other);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, true));
    expect(await state(theirs)).toEqual({ voided: false, consumed: false, reason: null });
  });
});

// frames-split §7.19 作业开启: once a run has ended, opening a container job is refused in the same transaction under the
// same task lock (consumption-producer.service.ts openMiniToolConsumption), so no plan job, meter or job is left behind.
describe("opening a container job after the run ended (frames-split §7.19)", () => {
  it.each(["failed", "cancelled"] as const)("OJ01 a %s run opens no job and leaves no plan job or consumption on the step", async (status) => {
    const f = await seedExecution(pg, "running");
    await pg`UPDATE tasks SET status=${status},completed_at=clock_timestamp() WHERE id=${f.taskId}`;
    await expect(identity(f)).rejects.toBeInstanceOf(Error);
    const steps = await pg<{ output: Record<string, unknown> | null }[]>`SELECT output FROM task_upstream_steps WHERE task_id=${f.taskId}`;
    expect(steps.map((step) => [step.output?.miniToolPlanJob, step.output?.miniToolConsumption])).toEqual(steps.map(() => [undefined, undefined]));
  });
});
