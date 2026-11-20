// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Independent delivery DD D01-D04/D09-D10/D17/D20-D22: actual task locks and PG transactions.
 * D11/D12 multiple-slot cases await a legal multiple-output frozen execution contract.
 * This suite does not run a queue, publish Redis media, read asset bytes or call a provider.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore, loadLocales } from "@breatic/core";
import { hashMiniToolValue, miniToolExecutionRecordSchema, type MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import {
  completeMiniToolConsumptionSet, recordMiniToolConsumptionLookup,
  miniToolDeliveryService, miniToolExecutionService, miniToolSettlementSchema, recordMiniToolConsumption,
  recordMiniToolStepResult, settleMiniToolCharge, upstreamStepRepo,
  type MiniToolDeliveryAck, type MiniToolDeliveryContext, type MiniToolDeliveryState, type MiniToolExecutionCompletion,
} from "@domain/index.js";
import { executionSnapshot, seedExecution, storeExecutionFixture, type ExecutionFixture } from "./execution-lifecycle-fixtures.js";
import { claimExecutionSettlement, executionIdentity } from "./execution-step-fixtures.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

let pg: ReturnType<typeof createPgClient>;
const ERROR = { code: "original_failure", message: "Original computation failed" };
const PRIVATE_ERROR = "delivery_history_failed";
interface OriginalIdentity { stepId: string; identity: { kind: "provider"; stepId: string } }
beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", CREDIT_MULTIPLIER: "1" }); loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "planned-delivery-fixture", max: 8 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/** Build the original one-slot observation without deriving expected media from the new owner.
 * @throws {never} Never.
 */
function completion(f: ExecutionFixture, expectedVersion = 0): MiniToolExecutionCompletion {
  return { planFingerprint: f.plan.planFingerprint, expectedVersion, error: null,
    outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }] };
}
/** Produce the independently fixed delivery sibling for the sole legal registered slot.
 * @throws {never} Never.
 */
function pending(f: ExecutionFixture): MiniToolDeliveryState {
  return { schemaVersion: 1, planFingerprint: f.plan.planFingerprint, version: 1, outputs: [{ outputIndex: 0, state: "pending" }], lastErrorCode: null };
}
/** Read raw SQL result siblings and physical parent fields independently of the new service.
 * @throws {Error} When fixture SQL cannot be read.
 */
async function snapshot(f: ExecutionFixture): Promise<Record<string, unknown>> {
  const parent = await executionSnapshot(pg, f);
  const steps = await pg`SELECT to_jsonb(s) AS row FROM task_upstream_steps s WHERE task_id=${f.taskId} ORDER BY position`;
  const usage = await pg`SELECT operation_key,cost_usd::text,credits::text FROM agent_usage_records
    WHERE operation_key IN (SELECT output#>>'{miniToolConsumption,consumptionKey}' FROM task_upstream_steps WHERE task_id=${f.taskId}) ORDER BY operation_key`;
  const holds = await pg`SELECT to_jsonb(h) AS row FROM credit_holds h WHERE reference_id=${f.taskId} ORDER BY id`;
  const ledger = await pg`SELECT to_jsonb(l) AS row FROM credit_ledger l WHERE reference_id=${f.taskId} ORDER BY id`;
  return { parent, steps: [...steps], usage: [...usage], holds: [...holds], ledger: [...ledger] };
}
/** Observe only the delivery sibling from raw SQL, without a projection that could invent it.
 * @throws {Error} When the original parent disappeared.
 */
async function stored(f: ExecutionFixture): Promise<unknown> {
  return (await executionSnapshot(pg, f)).result.miniToolDelivery;
}
/** Seed an old terminal manifest with no delivery sibling, isolating upgrade recovery from finish.
 * @throws {Error} When fixture SQL fails.
 */
async function oldManifest(f: ExecutionFixture, failed = false, registered = true): Promise<MiniToolExecutionRecord> {
  const current = miniToolExecutionRecordSchema.parse((await executionSnapshot(pg, f)).result.miniToolExecution);
  const record: MiniToolExecutionRecord = { ...current, status: failed ? "failed" : "completed", resultVersion: 1,
    outputs: [{ ...f.plan.outputs[0]!, result: registered ? f.registered : { status: "failed", error: ERROR }, late: failed && registered }], error: failed ? ERROR : null };
  await pg`UPDATE tasks SET status=${record.status},error_message=${failed ? ERROR.code : null},completed_at=clock_timestamp() WHERE id=${f.taskId}`;
  await storeExecutionFixture(pg, f, record);
  return record;
}
/** Seed a separate legal run at an earlier SQL primary key while reusing an actual canonical winner.
 * @throws {Error} When its immutable plan or SQL row cannot be saved.
 */
async function earlierRun(f: ExecutionFixture): Promise<ExecutionFixture> {
  const result = structuredClone(f); result.taskId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
  result.plan.taskId = result.taskId;
  const { requestFingerprint: _request, planFingerprint: _hash, ...projection } = result.plan;
  result.plan.planFingerprint = await hashMiniToolValue(projection);
  result.record = { ...result.record, runId: result.taskId, planFingerprint: result.plan.planFingerprint };
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,model,params,result)
    VALUES (${result.taskId},${result.userId},${result.projectId},${result.plan.spaceId},'video','append','mini_tool','running',${result.plan.model},${pg.json({ miniToolExecution: { ...result.plan } })},${pg.json({ preserved: { token: "original" } })})`;
  await storeExecutionFixture(pg, result, result.record);
  return result;
}
/** Persist the original returned provider result and canonical receipt, without a transfer.
 * @throws {Error} When the actual result or receipt transaction fails.
 */
async function returned(f: ExecutionFixture): Promise<OriginalIdentity> {
  const { stepId, identity } = await executionIdentity(f); const original = { stepId, identity };
  await recordMiniToolStepResult({ taskId: f.taskId, stepId: original.stepId, identity: original.identity, outcome: "done", result: ["https://provider.example.test/original.webm"] },
    { kind: "generate", parse: () => ({ providerURL: "https://provider.example.test/original.webm" }) });
  await upstreamStepRepo.recordInline(original.stepId, { "miniToolAsset:0": f.registered.assetId }, 0);
  return original;
}
/** Keep a real amount progression independent of delivery state and its version.
 * @throws {Error} When the original pending expense cannot be claimed or recorded.
 */
async function priced(f: ExecutionFixture, original: OriginalIdentity, record: boolean): Promise<void> {
  const claim = await claimExecutionSettlement(pg, f);
  await recordMiniToolConsumptionLookup({ taskId: f.taskId, stepId: original.stepId, claim: claim.claim, costs: [{ state: "known", usd: 0.3, source: "billing" }] });
  if (record) await recordMiniToolConsumption({ taskId: f.taskId, ...original, claim: claim.claim });
}
/** Bind an internal publication receipt to the original registered winner, not a temporary URL.
 * @throws {never} Never.
 */
function ack(f: ExecutionFixture, version = 1, disposition: MiniToolDeliveryAck["disposition"] = "published"): MiniToolDeliveryAck {
  return { deliveryVersion: version, planFingerprint: f.plan.planFingerprint, outputIndex: 0, assetId: f.registered.assetId, disposition };
}
/** Require a genuine pending delivery before testing an independent mutation boundary.
 * @throws {Error} When the original context cannot be initialized.
 */
async function ready(f: ExecutionFixture): Promise<MiniToolDeliveryContext> {
  const context = await miniToolDeliveryService.readMiniToolDelivery(f.taskId);
  expect(context.delivery).toEqual(pending(f)); return context;
}
/** Reject only a selected sibling change through a real PG trigger; both halves must roll back.
 * @throws {Error} When trigger setup, the operation or cleanup fails.
 */
async function rejectWrite(f: ExecutionFixture, field: "miniToolDelivery" | "miniToolExecution", operation: () => Promise<void>): Promise<void> {
  const name = `delivery_${randomUUID().replaceAll("-", "")}`;
  await pg.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result->'${field}' IS DISTINCT FROM OLD.result->'${field}' THEN RAISE EXCEPTION 'fixture_delivery_write_failed'; END IF; RETURN NEW; END $$`);
  await pg.unsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await operation(); } finally { await pg.unsafe(`DROP TRIGGER ${name} ON tasks`); await pg.unsafe(`DROP FUNCTION ${name}()`); }
}
/** Traverse bounded SQL keyset pages, retaining the exact order and current versions.
 * @throws {Error} When the finite fixture scan fails to terminate or produces duplicate positions.
 */
async function discover(limit = 2): Promise<{ taskId: string; deliveryVersion: number }[]> {
  const result: { taskId: string; deliveryVersion: number }[] = []; let cursor: { taskId: string } | undefined;
  for (let page = 0; page < 1000; page++) {
    const current = await miniToolDeliveryService.listPendingMiniToolDeliveries({ limit, ...(cursor === undefined ? {} : { cursor }) });
    expect(current.items.length).toBeLessThanOrEqual(limit);
    if (cursor !== undefined) for (const item of current.items) expect(item.taskId > cursor.taskId).toBe(true);
    result.push(...current.items);
    if (current.nextCursor === null) {
      expect(new Set(result.map((item) => item.taskId)).size).toBe(result.length);
      expect(result.map((item) => item.taskId)).toEqual(result.map((item) => item.taskId).sort());
      return result;
    }
    expect(current.nextCursor).toEqual({ taskId: current.items.at(-1)!.taskId }); cursor = current.nextCursor;
  }
  throw new Error("Finite fixture discovery did not terminate");
}

describe("planned registered media delivery SQL owner", () => {
  it("D01 creates registered manifest and the pending sibling in the same finish transaction", async () => {
    const f = await seedExecution(pg, "running"); const result = await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f));
    expect(await stored(f)).toEqual(pending(f)); expect(result.record.outputs[0]!.result).toEqual(f.registered);
    expect(result.record.resultVersion).toBe(1); expect((await executionSnapshot(pg, f)).result.preserved).toEqual({ token: "original" });
  });
  it.each(["miniToolDelivery", "miniToolExecution"] as const)("D01 rolls back both manifest and delivery if %s persistence fails", async (field) => {
    const f = await seedExecution(pg, "running"); const before = await snapshot(f);
    await rejectWrite(f, field, async () => { await expect(miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f))).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_delivery_write_failed") } }); });
    expect(await snapshot(f)).toEqual(before);
  });
  it("D02 initializes an old registered manifest under its original actor and frozen plan without altering public or financial siblings", async () => {
    const f = await seedExecution(pg, "running"); const record = await oldManifest(f); const parent = await executionSnapshot(pg, f);
    const context = await ready(f);
    expect(context).toMatchObject({ task: { id: f.taskId, userId: f.userId, projectId: f.projectId, status: "completed" }, execution: f.plan, record });
    const after = await executionSnapshot(pg, f); expect(after).toEqual({ ...parent, result: { ...parent.result, miniToolDelivery: pending(f) } });
    expect(await miniToolDeliveryService.readMiniToolDelivery(f.taskId)).toEqual(context);
  });
  it("D02 takes the real task lock while two readers initialize one missing sibling", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f);
    let reads: Promise<MiniToolDeliveryContext | Error>[] = [];
    await pg.begin(async (gate) => {
      await gate`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`;
      reads = [0, 1].map(() => miniToolDeliveryService.readMiniToolDelivery(f.taskId).then((value) => value, (error: Error) => error));
      await waitUntilBlockedOn(pg, ["tasks", "for update"], 2);
    });
    const results = await Promise.all(reads); for (const context of results) expect(context).toMatchObject({ delivery: pending(f) });
    expect(await stored(f)).toEqual(pending(f));
  });
  it("D02 initialization write failure leaves the old manifest without a half sibling", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); const before = await snapshot(f);
    await rejectWrite(f, "miniToolDelivery", async () => { await expect(miniToolDeliveryService.readMiniToolDelivery(f.taskId)).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_delivery_write_failed") } }); });
    expect(await snapshot(f)).toEqual(before);
  });
  it("D03 does not turn an active typed result and canonical step receipt into a public manifest or delivery", async () => {
    const f = await seedExecution(pg, "running"); await returned(f); const before = await snapshot(f);
    expect((await miniToolDeliveryService.readMiniToolDelivery(f.taskId)).delivery).toBeNull();
    expect(await snapshot(f)).toEqual(before); expect((await discover()).some((item) => item.taskId === f.taskId)).toBe(false);
  });
  it("D03 has no deliverable slot for a terminal manifest containing only a failed output", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f, true, false); const before = await snapshot(f);
    expect((await miniToolDeliveryService.readMiniToolDelivery(f.taskId)).delivery).toBeNull();
    expect(await snapshot(f)).toEqual(before); expect((await discover()).some((item) => item.taskId === f.taskId)).toBe(false);
  });
  it("D03 does not initialize delivery merely because a registered asset exists while the public slot is still null", async () => {
    const f = await seedExecution(pg, "running"); const before = await snapshot(f);
    expect((await miniToolDeliveryService.readMiniToolDelivery(f.taskId)).delivery).toBeNull(); expect(await snapshot(f)).toEqual(before);
  });
  it.each(["published", "history_only"] as const)("D04 keeps the original %s disposition and version on duplicate finish", async (disposition) => {
    const f = await seedExecution(pg, "running"); await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f)); await ready(f);
    const result = await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f, 1, disposition)); expect(result.acknowledged).toBe(true);
    const before = await snapshot(f); await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, 1));
    expect(await snapshot(f)).toEqual(before); expect(await stored(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: disposition }] });
  });
  it("D01/D04 adds a genuine late registered slot as pending while keeping the original failed parent", async () => {
    const f = await seedExecution(pg, "running"); await returned(f); await oldManifest(f, true, false);
    expect((await miniToolDeliveryService.readMiniToolDelivery(f.taskId)).delivery).toBeNull();
    const result = await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f, 1));
    expect(result.record).toMatchObject({ status: "failed", error: ERROR, resultVersion: 2, outputs: [{ outputIndex: 0, result: f.registered, late: true }] });
    expect(await stored(f)).toEqual(pending(f));
  });
  it("D04 preserves delivery across real known, recorded and settled consumption changes", async () => {
    const f = await seedExecution(pg, "running"); const original = await returned(f);
    await miniToolExecutionService.finishMiniToolExecution(f.taskId, completion(f)); await ready(f);
    expect((await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f))).acknowledged).toBe(true);
    const delivery = await stored(f); await priced(f, original, false); expect(await stored(f)).toEqual(delivery);
    const parent = await executionSnapshot(pg, f); const period = miniToolSettlementSchema.parse(parent.result.settlement);
    const claim = { version: period.version, leaseToken: period.leaseToken! };
    await recordMiniToolConsumption({ taskId: f.taskId, ...original, claim }); expect(await stored(f)).toEqual(delivery);
    await completeMiniToolConsumptionSet(f.taskId); expect(await settleMiniToolCharge(f.taskId)).toMatchObject({ state: "settled", credits: 30 });
    expect(await stored(f)).toEqual(delivery);
    expect((await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId)).resultVersion).toBe(1);
  });
  it("D04 preserves an existing pending amount and held estimate while reading, deferring and acknowledging media", async () => {
    const f = await seedExecution(pg, "running"); await returned(f); await oldManifest(f);
    await pg`INSERT INTO credit_holds (studio_id,actor_user_id,reference_id,amount,status,expires_at)
      VALUES (${f.studioId},${f.userId},${f.taskId},30,'held','2099-01-01T00:00:00Z')`;
    const before = await snapshot(f); await ready(f);
    await miniToolDeliveryService.deferMiniToolDelivery(f.taskId, { deliveryVersion: 1, outputIndex: 0, errorCode: PRIVATE_ERROR });
    await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f));
    const after = await snapshot(f);
    const parent = await executionSnapshot(pg, f);
    const { miniToolDelivery: _delivery, ...result } = parent.result;
    expect({ ...after, parent: { ...parent, result } }).toEqual(before);
    expect(await settleMiniToolCharge(f.taskId)).toEqual({ state: "pending" });
    const [hold] = await pg`SELECT status,amount::float8 AS amount FROM credit_holds WHERE reference_id=${f.taskId}`;
    expect(hold).toEqual({ status: "held", amount: 30 });
  });
  it("D09 leaves pending recoverable when the actual SQL ACK update fails", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); await ready(f); const before = await snapshot(f);
    await rejectWrite(f, "miniToolDelivery", async () => { await expect(miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f))).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_delivery_write_failed") } }); });
    expect(await snapshot(f)).toEqual(before);
    expect((await discover()).find((item) => item.taskId === f.taskId)).toEqual({ taskId: f.taskId, deliveryVersion: 1 });
    expect((await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f))).acknowledged).toBe(true);
    expect((await discover()).some((item) => item.taskId === f.taskId)).toBe(false);
  });
  it("D10 allows only one real task-lock CAS winner for two acknowledgements of the same version", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); await ready(f);
    let writes: Promise<Awaited<ReturnType<typeof miniToolDeliveryService.ackMiniToolDelivery>> | Error>[] = [];
    await pg.begin(async (gate) => {
      await gate`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`;
      writes = [0, 1].map(() => miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f)).then((value) => value, (error: Error) => error));
      await waitUntilBlockedOn(pg, ["tasks", "for update"], 2);
    });
    const results = await Promise.all(writes);
    expect(results.map((result) => result instanceof Error ? result.message : result.acknowledged).sort()).toEqual([false, true]);
    expect(await stored(f)).toEqual({ ...pending(f), version: 2, outputs: [{ outputIndex: 0, state: "published" }] });
  });
  it.each(["plan", "index", "asset", "old version"] as const)("D10 rejects or ignores a mismatched %s ACK without clearing original pending", async (field) => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); await ready(f); const before = await snapshot(f); const input = ack(f);
    if (field === "plan") input.planFingerprint = "f".repeat(64);
    if (field === "index") input.outputIndex = 1;
    if (field === "asset") input.assetId = randomUUID();
    if (field === "old version") input.deliveryVersion = 0;
    const result = await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, input).then((value) => value, () => null);
    if (result !== null) expect(result.acknowledged).toBe(false);
    expect(await snapshot(f)).toEqual(before);
  });
  it("D10 repeated successful ACK is idempotent and does not advance its delivery version twice", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); await ready(f);
    expect((await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f))).acknowledged).toBe(true); const before = await snapshot(f);
    expect((await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f))).acknowledged).toBe(false);
    expect(await snapshot(f)).toEqual(before);
  });
  it("D09 keeps a stable private diagnostic without modifying media, fee or parent fields", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); await ready(f); const parent = await executionSnapshot(pg, f);
    await miniToolDeliveryService.deferMiniToolDelivery(f.taskId, { deliveryVersion: 1, outputIndex: 0, errorCode: PRIVATE_ERROR });
    expect(await stored(f)).toEqual({ ...pending(f), lastErrorCode: PRIVATE_ERROR });
    expect(await executionSnapshot(pg, f)).toEqual({ ...parent, result: { ...parent.result, miniToolDelivery: { ...pending(f), lastErrorCode: PRIVATE_ERROR } } });
  });
  it.each(["old version", "missing index", "completed slot"] as const)("D09 does not write a deferral for %s", async (kind) => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); await ready(f);
    if (kind === "completed slot") await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f));
    const before = await snapshot(f);
    await miniToolDeliveryService.deferMiniToolDelivery(f.taskId, { deliveryVersion: kind === "old version" ? 0 : kind === "completed slot" ? 2 : 1, outputIndex: kind === "missing index" ? 1 : 0, errorCode: PRIVATE_ERROR }).then(() => undefined, () => undefined);
    expect(await snapshot(f)).toEqual(before);
  });
  it("D09 rolls back a failed diagnostic update instead of losing pending", async () => {
    const f = await seedExecution(pg, "running"); await oldManifest(f); await ready(f); const before = await snapshot(f);
    await rejectWrite(f, "miniToolDelivery", async () => { await expect(miniToolDeliveryService.deferMiniToolDelivery(f.taskId, { deliveryVersion: 1, outputIndex: 0, errorCode: PRIVATE_ERROR })).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_delivery_write_failed") } }); });
    expect(await snapshot(f)).toEqual(before);
  });
  it("D17 discovers registered pending media even after the actual charge is settled and billed", async () => {
    const f = await seedExecution(pg, "running"); const original = await returned(f); await oldManifest(f); await completeMiniToolConsumptionSet(f.taskId);
    await priced(f, original, true); expect(await settleMiniToolCharge(f.taskId)).toMatchObject({ state: "settled", credits: 30 });
    expect((await executionSnapshot(pg, f)).billed_at).toEqual(expect.any(String));
    const items = await discover(); expect(items.find((item) => item.taskId === f.taskId)).toEqual({ taskId: f.taskId, deliveryVersion: 1 });
    expect(await stored(f)).toEqual(pending(f));
  });
  it("D20 keyset traversal includes old missing siblings, skips finished deliveries and handles an inserted earlier task on a fresh cycle", async () => {
    const fixtures: ExecutionFixture[] = [];
    for (let index = 0; index < 5; index++) { const f = await seedExecution(pg, "running"); await oldManifest(f); fixtures.push(f); }
    const finished = fixtures[0]!; await ready(finished); await miniToolDeliveryService.ackMiniToolDelivery(finished.taskId, ack(finished));
    const items = await discover(2);
    for (const f of fixtures.slice(1)) expect(items.find((item) => item.taskId === f.taskId)).toEqual({ taskId: f.taskId, deliveryVersion: 1 });
    expect(items.some((item) => item.taskId === finished.taskId)).toBe(false);
    const f = await earlierRun(fixtures[1]!); expect(f.taskId < items[0]!.taskId).toBe(true);
    await oldManifest(f);
    expect((await discover(2)).find((item) => item.taskId === f.taskId)).toEqual({ taskId: f.taskId, deliveryVersion: 1 });
  });
  it("D21 returns only the original public manifest while internal delivery diagnostics remain private", async () => {
    const f = await seedExecution(pg, "running"); const record = await oldManifest(f); await ready(f);
    await miniToolDeliveryService.deferMiniToolDelivery(f.taskId, { deliveryVersion: 1, outputIndex: 0, errorCode: PRIVATE_ERROR });
    const before = await snapshot(f); const result = await miniToolExecutionService.getMiniToolExecution(f.projectId, f.taskId, f.viewerId);
    expect(result).toEqual(record); expect(miniToolExecutionRecordSchema.parse(result)).toEqual(record); expect(await snapshot(f)).toEqual(before);
  });
  it("D22 reads and acknowledges original canonical media after the original deadline without replacing F or allocating provider steps", async () => {
    const f = await seedExecution(pg, "running"); const record = await oldManifest(f); await pg`UPDATE tasks SET created_at=clock_timestamp() - interval '3 hours' WHERE id=${f.taskId}`;
    const frozen = structuredClone(f.plan); const parent = await executionSnapshot(pg, f); const context = await ready(f);
    expect(context.execution).toEqual(frozen); expect(context.record).toEqual(record);
    await miniToolDeliveryService.ackMiniToolDelivery(f.taskId, ack(f));
    const after = await executionSnapshot(pg, f); expect(after.params).toEqual(parent.params);
    expect(after.result.miniToolExecution).toEqual(parent.result.miniToolExecution); expect(after.status).toBe("completed");
    expect(await upstreamStepRepo.listSteps(f.taskId)).toEqual([]);
    const { requestFingerprint: _requestFingerprint, planFingerprint: _planFingerprint, ...projection } = f.plan;
    expect(await hashMiniToolValue(projection)).toBe(frozen.planFingerprint);
  });
});
