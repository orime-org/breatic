// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, getNodeTaskConfig, initCore, loadLocales } from "@breatic/core";
import { miniToolConsumptionKey, type MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import {
  miniToolExecutionService, upstreamStepRepo, taskRepo, beginMiniToolStepAttempt, recordMiniToolStepIdentity, recordMiniToolStepResult,
  claimMiniToolSettlement, confirmMiniToolConsumption, recordMiniToolConsumption,
  openMiniToolConsumption, completeMiniToolConsumptionSet, settleMiniToolCharge,
  type MiniToolExecutionCompletion,
} from "@domain/index.js";
import { executionSnapshot, seedExecution, storeExecutionFixture, type ExecutionFixture } from "./execution-lifecycle-fixtures.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

let pg: ReturnType<typeof createPgClient>;
const ERROR = { code: "registration_failed", message: "Original registration failure" };
const P = "planned-original-prediction";
beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1" }); loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "execution-lifecycle", max: 8 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/** Build the independently prescribed complete indexed observation. */
function completion(f: ExecutionFixture, failed = false, expectedVersion = 0): MiniToolExecutionCompletion {
  return { planFingerprint: f.plan.planFingerprint, expectedVersion, consumptionSet: "uncertain", error: failed ? ERROR : null,
    outputs: [{ ...f.plan.outputs[0]!, result: failed ? { status: "failed", error: ERROR } : f.registered, late: false }] };
}
/** Independently seed a terminal namespace so a late CAS test does not require start/finish to be GREEN.
 * @throws {Error} On a fixture SQL failure.
 */
async function terminal(f: ExecutionFixture, failed = false): Promise<MiniToolExecutionRecord> {
  const held = await publicRecord(f);
  const r: MiniToolExecutionRecord = { ...held, status: failed ? "failed" : "completed", resultVersion: 1,
    outputs: completion(f, failed).outputs, error: failed ? ERROR : null };
  await pg`UPDATE tasks SET status=${r.status},error_message=${failed ? ERROR.code : null},completed_at=clock_timestamp() WHERE id=${f.taskId}`;
  await storeExecutionFixture(pg, f, r); return r;
}
/** Read the public JSON without going through the RED public-reader stub.
 * @throws {Error} On a fixture SQL failure.
 */
async function publicRecord(f: ExecutionFixture): Promise<MiniToolExecutionRecord> {
  const row = await executionSnapshot(pg, f); return row.result.miniToolExecution as MiniToolExecutionRecord;
}
/** Prepare a real durable intent and optionally its real pending expense.
 * @throws {Error} When an original SQL persistence owner fails.
 */
async function identity(f: ExecutionFixture, chargeTo: "user" | "platform" = "user", save = true): Promise<{ stepId: string; attemptId: string; key: string; identity: { kind: "provider"; provider: "wavespeed"; predictionId: string } }> {
  const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]);
  if (!s) throw new Error("Fixture step disappeared"); const attemptId = randomUUID();
  const task = await taskRepo.getMiniToolExecutionTask(f.taskId); if (!task) throw new Error("Missing fixture task");
  await beginMiniToolStepAttempt({ taskId: f.taskId, stepId: s.id, attemptId, deadlineAt: task.createdAt.getTime() + getNodeTaskConfig().default_budget_ms, requestBody: { ...f.plan.body }, chargeTo });
  const upstream = { kind: "provider" as const, provider: "wavespeed" as const, predictionId: P };
  if (save) await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: s.id, attemptId, predictionId: P });
  return { stepId: s.id, attemptId, key: await miniToolConsumptionKey({ taskId: f.taskId, stepId: s.id, identity: upstream }), identity: upstream };
}
/** Persist the original provider-returned boundary and its canonical receipt before a late delivery.
 * @throws {Error} When a real result or receipt write fails.
 */
async function returned(f: ExecutionFixture): Promise<void> {
  const i = await identity(f);
  await recordMiniToolStepResult({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, outcome: "done", result: ["https://provider.example.test/original.webm"] },
    { kind: "generate", parse: () => ({ providerURL: "https://provider.example.test/original.webm" }) });
  await upstreamStepRepo.recordInline(i.stepId, { "miniToolAsset:0": f.registered.assetId }, 0);
}
/** Claim the existing database cycle, with no upstream query or fabricated lease.
 * @throws {Error} If the fixture's actual cycle is not claimable.
 */
async function claim(f: ExecutionFixture): Promise<NonNullable<Awaited<ReturnType<typeof claimMiniToolSettlement>>>> {
  const row = await executionSnapshot(pg, f); const period = row.result.settlement as { version: number };
  const c = await claimMiniToolSettlement({ taskId: f.taskId, settlementVersion: period.version });
  if (!c) throw new Error("Fixture settlement was not claimed"); return c;
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
    const f = await seedExecution(pg, "pending", false); const first = await miniToolExecutionService.startMiniToolExecution(f.taskId, "original-job");
    expect(first.execution).toEqual(f.plan); expect(first.task).toMatchObject({ id: f.taskId, userId: f.userId, status: "running" });
    expect(first.record).toEqual({ ...f.record, status: "running" }); const before = await executionSnapshot(pg, f);
    expect(before.result).toEqual({ preserved: { token: "original" }, miniToolExecution: { ...f.record, status: "running" } });
    expect(before.started_at).toEqual(expect.any(String));
    await miniToolExecutionService.startMiniToolExecution(f.taskId, "second-job"); expect((await executionSnapshot(pg, f)).started_at).toBe(before.started_at);
  });
  it("W15 rolls back running and namespace together when initialization persistence fails", async () => {
    const f = await seedExecution(pg, "pending", false); const before = await executionSnapshot(pg, f);
    await rejectWrite(f, "public", async () => { await expect(miniToolExecutionService.startMiniToolExecution(f.taskId, "job")).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["model", "body", "project", "space", "task", "targets"])("W02/W03 rejects frozen-parent mismatch %s without writes", async (field) => {
    const f = await seedExecution(pg); const plan = structuredClone(f.plan);
    if (field === "model") await pg`UPDATE tasks SET model='different-model' WHERE id=${f.taskId}`;
    else {
      if (field === "body") Object.assign(plan.body, { preserve_audio: false });
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
    expect(result.record).toEqual({ ...f.record, status: "completed", resultVersion: 1, outputs: completion(f).outputs });
    const row = await executionSnapshot(pg, f); expect(row.status).toBe("completed"); expect(row.result.preserved).toEqual({ token: "original" });
    expect(result.record.sourceBindings[0]!.mediaInfo.duration).toBe(5.055); expect(result.record.outputs[0]!.result).toEqual(f.registered);
  });
  it("M03 replays identical media without version inflation or sibling changes", async () => {
    const f = await seedExecution(pg); const r = await terminal(f); const before = await executionSnapshot(pg, f);
    expect((await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f))).record).toEqual(r); expect(await executionSnapshot(pg, f)).toEqual(before);
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
  it("M06 preserves first failed parent/error while publishing valid original late media as version2", async () => {
    const f = await seedExecution(pg); await returned(f); await terminal(f, true);
    const r = await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false, 1));
    expect(r.record).toMatchObject({ status: "failed", resultVersion: 2, error: ERROR, outputs: [{ ...f.plan.outputs[0], result: f.registered, late: true }] });
    expect((await executionSnapshot(pg, f)).status).toBe("failed");
  });
  it("M07 observes both late CAS contenders parked on the actual task lock", async () => {
    const f = await seedExecution(pg); await returned(f); await terminal(f, true);
    let release!: () => void; let entered!: () => void; const gate = new Promise<void>((r) => { release = r; }); const ready = new Promise<void>((r) => { entered = r; });
    const owner = pg.begin(async (tx) => { await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; entered(); await gate; }); await ready;
    const a = miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false, 1)); const b = miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, false, 1));
    void a.catch(() => undefined); void b.catch(() => undefined);
    try { await waitUntilBlockedOn(pg, ["tasks", "for update"], 2); release(); await owner;
      const results = await Promise.all([a, b]); expect(results.map((r) => r.record.resultVersion)).toEqual([2, 2]); expect((await publicRecord(f)).resultVersion).toBe(2);
    } finally { release(); await owner; await Promise.allSettled([a, b]); }
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
    await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: i.stepId, attemptId: i.attemptId, predictionId: P }); expect((await publicRecord(f)).usage).toEqual([expected]);
  });
  it("B02 leaves no fabricated usage when only a durable intent exists", async () => {
    const f = await seedExecution(pg, "running"); await identity(f, "user", false);
    expect((await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId)).billingState).toBe("waiting"); expect((await publicRecord(f)).usage).toEqual([]);
  });
  it("U01 rolls original attempt/identity/expense back when the public pending write fails", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f, "user", false); const before = await financialSnapshot(f, i.stepId);
    await rejectWrite(f, "public", async () => { await expect(recordMiniToolStepIdentity({ taskId: f.taskId, stepId: i.stepId, attemptId: i.attemptId, predictionId: P })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await financialSnapshot(f, i.stepId)).toEqual(before);
  });
  it("U01 also mirrors the original generic consumption producer within its own transaction", async () => {
    const f = await seedExecution(pg, "running"); const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing fixture step");
    await pg`UPDATE task_upstream_steps SET prediction_id=${P} WHERE id=${s.id}`;
    const upstream = { kind: "provider" as const, provider: "wavespeed" as const, predictionId: P };
    const c = await openMiniToolConsumption({ taskId: f.taskId, stepId: s.id, identity: upstream, chargeTo: "user", creditMultiplier: 1, containerPricing: null });
    expect((await publicRecord(f)).usage).toEqual([{ consumptionKey: c.consumptionKey, state: "pending", chargeTo: "user", costUsd: null, credits: null }]);
  });
  it("U01 rolls generic producer step and cycle back if the public pending write fails", async () => {
    const f = await seedExecution(pg, "running"); const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing fixture step");
    await pg`UPDATE task_upstream_steps SET prediction_id=${P} WHERE id=${s.id}`; const before = await financialSnapshot(f, s.id);
    await rejectWrite(f, "public", async () => { await expect(openMiniToolConsumption({ taskId: f.taskId, stepId: s.id, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, chargeTo: "user", creditMultiplier: 1, containerPricing: null })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await financialSnapshot(f, s.id)).toEqual(before);
  });
  it("U02 confirms known in both owners before usage recording and without media version changes", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim, costUsd: 0.3, costSource: "generation_lookup", raw: { total: 0.3 } });
    expect((await publicRecord(f)).usage).toEqual([{ consumptionKey: i.key, state: "known", chargeTo: "user", costUsd: 0.3, credits: null }]); expect((await publicRecord(f)).resultVersion).toBe(0);
    const [count] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key=${i.key}`; expect(count).toEqual({ count: 0 });
  });
  it("U03 rolls known back to pending if the public mirror update fails", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f); const before = await financialSnapshot(f, i.stepId);
    await rejectWrite(f, "public", async () => { await expect(confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim, costUsd: 0.3, costSource: "generation_lookup", raw: {} })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await financialSnapshot(f, i.stepId)).toEqual(before);
  });
  it.each(["user", "platform"] as const)("U04/U07 records actual %s expense and its public credits exactly once", async (chargeTo) => {
    const f = await seedExecution(pg, "running"); const i = await identity(f, chargeTo); const c = await claim(f);
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim, costUsd: 0.3, costSource: "generation_lookup", raw: { cost: 0.3 } });
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim });
    const expected = [{ consumptionKey: i.key, state: "recorded", chargeTo, costUsd: 0.3, credits: chargeTo === "platform" ? 0 : 30 }];
    expect((await publicRecord(f)).usage).toEqual(expected);
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity }); expect((await publicRecord(f)).usage).toEqual(expected);
    const [count] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key=${i.key}`; expect(count).toEqual({ count: 1 });
  });
  it.each(["usage", "step", "public", "settlement"] as const)("U05 rolls all record writes back at %s", async (point) => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim, costUsd: 0.3, costSource: "generation_lookup", raw: {} });
    const before = await financialSnapshot(f, i.stepId);
    await rejectWrite(f, point, async () => { await expect(recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_execution_write_failed") } }); });
    expect(await financialSnapshot(f, i.stepId)).toEqual(before);
  });
  it("U06 ignores an expired claim without changing mirrored pending or media", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f); const before = await executionSnapshot(pg, f);
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: { ...c.claim, leaseToken: "stale-token" }, costUsd: 999, costSource: "generation_lookup", raw: {} });
    expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it("U08/U09 keeps registered output readable while billing remains pending and the hold is held", async () => {
    const f = await seedExecution(pg, "running"); await identity(f); await terminal(f);
    await pg`INSERT INTO credit_holds (studio_id,actor_user_id,reference_id,amount,status,expires_at) VALUES (${f.studioId},${f.userId},${f.taskId},30,'held','2099-01-01T00:00:00Z')`;
    const r = await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId); expect(r.outputs[0]!.result).toEqual(f.registered); expect(r.billingState).toBe("waiting");
    expect(await settleMiniToolCharge(f.taskId)).toEqual({ state: "pending" }); const [hold] = await pg`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`; expect(hold).toEqual({ status: "held" });
  });
  it("U10 settles a closed recorded task once while retaining the media and public fees", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim, costUsd: 0.3, costSource: "generation_lookup", raw: {} });
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim }); await terminal(f); await completeMiniToolConsumptionSet(f.taskId);
    const first = await settleMiniToolCharge(f.taskId); expect(first).toMatchObject({ state: "settled", credits: 30, first: true });
    expect(await settleMiniToolCharge(f.taskId)).toMatchObject({ state: "settled", credits: 30, first: false });
    const r = await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId); expect(r).toMatchObject({ status: "completed", resultVersion: 1, billingState: "settled", usage: [{ consumptionKey: i.key, state: "recorded", chargeTo: "user", costUsd: 0.3, credits: 30 }] }); expect(r.outputs[0]!.result).toEqual(f.registered);
  });
  it("B04 permits recorded actual expense beside an active idle cycle", async () => {
    const f = await seedExecution(pg, "running"); const i = await identity(f); const c = await claim(f);
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim, costUsd: 0.3, costSource: "generation_lookup", raw: {} });
    await recordMiniToolConsumption({ taskId: f.taskId, stepId: i.stepId, identity: i.identity, claim: c.claim });
    const r = await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId); expect(r).toMatchObject({ status: "running", resultVersion: 0, billingState: "idle", usage: [{ consumptionKey: i.key, state: "recorded", costUsd: 0.3, credits: 30 }] });
  });
  it("U11 complete call-set proof preserves the actual live checking lease and media", async () => {
    const f = await seedExecution(pg, "running"); await identity(f); const c = await claim(f); await terminal(f); const before = await executionSnapshot(pg, f);
    const period = await completeMiniToolConsumptionSet(f.taskId); expect(period).toMatchObject({ version: c.claim.version, state: "checking", leaseToken: c.claim.leaseToken, leaseUntil: c.leaseUntil, consumptionSetComplete: true });
    expect((await executionSnapshot(pg, f)).result.miniToolExecution).toEqual(before.result.miniToolExecution);
  });
  it("U12 does not close an unresolved intent when failure is committed", async () => {
    const f = await seedExecution(pg, "running"); await identity(f, "user", false);
    const c = completion(f, true); c.consumptionSet = "uncertain"; await miniToolExecutionService.finishMiniToolExecution(f.taskId, c);
    const row = await executionSnapshot(pg, f); expect(row.status).toBe("failed"); expect(row.result.settlement).toMatchObject({ consumptionSetComplete: false }); expect(row.billed_at).toBeNull();
  });
  it("B01 builds active0 from accepted F without writing on a read", async () => {
    const f = await seedExecution(pg, "pending", false); const before = await executionSnapshot(pg, f);
    expect(await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId)).toEqual(f.record); expect(await executionSnapshot(pg, f)).toEqual(before);
  });
  it.each(["idle", "waiting", "checking", "settled"] as const)("B03 reads the actual %s period without a steps lookup", async (state) => {
    const f = await seedExecution(pg); await pg`UPDATE tasks SET result=result || ${pg.json({ settlement: { version: 1, state, pendingConsumptionKeys: [], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: false } })} WHERE id=${f.taskId}`;
    expect((await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId)).billingState).toBe(state);
  });
  it("B05 refuses damaged persisted settlement instead of treating it as absent", async () => {
    const f = await seedExecution(pg); await pg`UPDATE tasks SET result=result || ${pg.json({ settlement: { state: "broken" } })} WHERE id=${f.taskId}`;
    await expect(miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId)).rejects.toBeInstanceOf(Error);
  });
});
