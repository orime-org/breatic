// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Independent C/E oracle: real PG, Redis, original step/settlement owners; remote adapters and external price lookup are controlled. */
import { randomBytes, randomUUID } from "node:crypto";
import type { createApp } from "@server/app.js";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { Job } from "bullmq";
import { ConflictError, ValidationError, createPgClient, getNodeTaskConfig, getRedis, getStreamRedis,
  initCore, initLogger, loadLocales, logger, revokeSession, sessionCookieName, setSession } from "@breatic/core";
import { DeadlinePassed } from "@breatic/shared";
import { miniToolExecutionRecordSchema, videoContainerJobId, type MiniToolExecutionRecord } from "@breatic/shared/mini-tools";
import {
  beginMiniToolStepAttempt, claimMiniToolSettlement, confirmMiniToolConsumption, creditHoldService, failMiniToolStep,
  miniToolConsumptionRecordSchema, miniToolExecutionService, miniToolSettlementSchema, miniToolStepStateSchema,
  openMiniToolConsumption, recordMiniToolConsumption, recordMiniToolStepIdentity, recordMiniToolStepResult,
  runMiniToolSettlement, settleMiniToolCharge, upstreamStepRepo,
  type MiniToolExecutionCompletion, type MiniToolExecutionJob, type MiniToolSettlementClaim, type MiniToolConsumptionLookupInput,
} from "@breatic/domain";
import type * as wavespeedModule from "@worker/providers/wavespeed.js";
import type * as uploadModule from "@worker/handlers/backend-upload.js";
import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";
import { runMiniToolExecutionTask } from "@worker/handlers/mini-tool/run-execution-task.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { executionSnapshot, seedExecution, storeExecutionFixture, type ExecutionFixture } from "../../../domain/src/mini-tool/__tests__/execution-lifecycle-fixtures.js";
import { seedDesignatedLot } from "@server/__tests__/integration/studio-credit-fixtures.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import { fakeIngestJobs, INGEST_ENV } from "./ingest-jobs-fake.js";

const { runPrediction, storeFromUrl } = vi.hoisted(() => ({ runPrediction: vi.fn<typeof wavespeedModule.runPrediction>(), storeFromUrl: vi.fn<typeof uploadModule.storeFromUrl>() }));
vi.mock("@worker/providers/wavespeed.js", async (original) => ({ ...await original<typeof wavespeedModule>(), runPrediction }));
vi.mock("@worker/handlers/backend-upload.js", async (original) => ({ ...await original<typeof uploadModule>(), storeFromUrl }));
const P = "original-terminal-prediction";
const TEMP = "https://provider.example.test/SELECT/params/result.webm";
const ERROR = { code: "internal" };
let pg: ReturnType<typeof createPgClient>;
let app: ReturnType<typeof createApp>;
const tokens: string[] = [];
interface Prepared { stepId: string; attemptIds: string[]; deadlineAt: number }
interface Captured { err: Error; ctx: Record<string, unknown> }

beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "true", CREDIT_MULTIPLIER: "1", WAVESPEED_API_KEY: "unused-terminal-fixture",
    STRIPE_SECRET_KEY: "sk_test_unused", STRIPE_WEBHOOK_SECRET: "whsec_unused", UPLOAD_BASE_URL: "https://assets.example.test", ...INGEST_ENV });
  loadLocales(); initLogger("planned-terminal-fixture"); pg = createPgClient(inject("DATABASE_URL"), { name: "planned-terminal-fixtures", max: 8 });
  const { createApp } = await import("@server/app.js"); app = createApp();
});
// S6e E3b (inner#1306 §90): the removal's model input is prepared on standard-4 before generate.
beforeEach(() => { vi.resetAllMocks(); fakeIngestJobs(); });
afterAll(async () => { for (const token of tokens) await revokeSession(getRedis(), token); await pg.end(); initCore(process.env); vi.unstubAllGlobals(); });

/** Seed a funded original run and real target row, without invoking a provider or browser.
 * @throws {Error} On an actual fixture or credit-owner failure.
 */
async function seed(): Promise<ExecutionFixture> {
  const f = await seedExecution(pg, "running"); await seedDesignatedLot(pg, f, 1000);
  expect((await creditHoldService.reserveCredits({ projectId: f.projectId, actorUserId: f.userId, referenceId: f.taskId, amount: 30, ttlMs: getNodeTaskConfig().default_budget_ms })).ok).toBe(true);
  await pg`INSERT INTO node_tasks (project_id,space_id,node_id,kind,action,status,started_by_user_id,budget_ms,label,task_id)
    VALUES (${f.projectId},${f.plan.spaceId},${f.plan.outputs[0]!.nodeId},'generation','mini_tool','running',${f.userId},${getNodeTaskConfig().default_budget_ms},'terminal',${f.taskId})`;
  return f;
}
/** Queue controls are local, while all production persistence underneath the pickup remains real.
 * @throws {never} Never.
 */
function job(f: ExecutionFixture, terminal = false): Job<MiniToolExecutionJob> {
  return { name: "execute-mini-tool", id: f.taskId, data: { taskId: f.taskId, source: "mini_tool", executionKind: "planned" },
    attemptsMade: 0, opts: { attempts: 3 }, ...(terminal ? { finishedOn: Date.now() } : {}),
    extendLock: vi.fn().mockResolvedValue(1), moveToDelayed: vi.fn().mockResolvedValue(undefined) } as unknown as Job<MiniToolExecutionJob>;
}
/** Prepare the original attempts through their actual owner before any identity is saved.
 * @throws {Error} When a legitimate original request cannot be persisted.
 */
async function prepare(f: ExecutionFixture, count = 1, chargeTo: "user" | "platform" = "user"): Promise<Prepared> {
  const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing original step");
  const task = await executionSnapshot(pg, f);
  const [clock] = await pg<{ deadline: number }[]>`SELECT (extract(epoch FROM created_at)*1000)::float8 + ${getNodeTaskConfig().default_budget_ms} AS deadline FROM tasks WHERE id=${f.taskId}`;
  if (!clock || task.status !== "running") throw new Error("Original preparation fixture is not running"); const deadlineAt = Math.trunc(clock.deadline);
  const attemptIds: string[] = [];
  for (let n = 0; n < count; n++) {
    const attemptId = randomUUID(); attemptIds.push(attemptId);
    expect((await beginMiniToolStepAttempt({ taskId: f.taskId, stepId: s.id, attemptId, deadlineAt, requestBody: { ...f.plan.body }, chargeTo })).shouldSubmit).toBe(true);
  }
  return { stepId: s.id, attemptIds, deadlineAt };
}
/** Save the original receipt without submitting any remote task.
 * @throws {Error} When the real receipt transaction rejects its original proof.
 */
async function identity(f: ExecutionFixture, p: Prepared, index = 0, predictionId = P): Promise<void> {
  const result = await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: p.stepId, attemptId: p.attemptIds[index]!, predictionId }); expect(result.conflict).toBe(false);
}
/** Save the actual typed returned boundary through the existing result owner.
 * @throws {Error} When the original step or result identity is invalid.
 */
async function returned(f: ExecutionFixture, chargeTo: "user" | "platform" = "user"): Promise<Prepared> {
  const p = await prepare(f, 1, chargeTo); await identity(f, p);
  await recordMiniToolStepResult({ taskId: f.taskId, stepId: p.stepId, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, outcome: "done", result: [TEMP] },
    { kind: "generate", parse: () => ({ providerURL: TEMP }) }); return p;
}
/** Read the exact persisted public projection and original financial period independently.
 * @throws {Error} When persistent fixture data is malformed.
 */
async function view(f: ExecutionFixture): Promise<{ record: MiniToolExecutionRecord; period: ReturnType<typeof miniToolSettlementSchema.parse> | null; hold: string; billed: string | null }> {
  const task = await executionSnapshot(pg, f); const [hold] = await pg<{ status: string }[]>`SELECT status FROM credit_holds WHERE reference_id=${f.taskId}`;
  if (!hold) throw new Error("Missing actual held quote");
  return { record: miniToolExecutionRecordSchema.parse(task.result.miniToolExecution), period: task.result.settlement === undefined ? null : miniToolSettlementSchema.parse(task.result.settlement), hold: hold.status, billed: task.billed_at };
}
/** Observe the actual terminal QueueEvents callback without fabricating a new pickup.
 * @throws {Error} When original cleanup persistence fails.
 */
async function cleanup(f: ExecutionFixture, reason = "terminal fixture failure"): Promise<void> {
  expect(await cleanupFailedJobNodes(getStreamRedis(), job(f, true), reason)).toBe(1);
}
/** Claim and confirm the original price through an actual database lease, optionally recording its usage.
 * @throws {Error} When a fixture cycle cannot be claimed or its actual lookup cannot commit.
 */
async function known(f: ExecutionFixture, p: Prepared, record = false): Promise<MiniToolSettlementClaim> {
  const before = await view(f); if (!before.period) throw new Error("Missing original settlement cycle");
  const claim = await claimMiniToolSettlement({ taskId: f.taskId, settlementVersion: before.period.version }); if (!claim) throw new Error("Original lookup lease not acquired");
  await confirmMiniToolConsumption({ taskId: f.taskId, stepId: p.stepId, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, claim: claim.claim,
    costUsd: 0.3, costSource: "generation_lookup", raw: { fixtureBill: 0.3 } });
  if (record) await recordMiniToolConsumption({ taskId: f.taskId, stepId: p.stepId, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, claim: claim.claim });
  return claim.claim;
}
/** Keep media-version comparisons separate from independently advancing public expense fields.
 * @throws {never} Never.
 */
function media(record: MiniToolExecutionRecord): unknown {
  return { status: record.status, resultVersion: record.resultVersion, error: record.error, outputs: record.outputs };
}
/** Construct only the approved full indexed terminal observation.
 * @throws {never} Never.
 */
function failure(f: ExecutionFixture): MiniToolExecutionCompletion {
  return { planFingerprint: f.plan.planFingerprint, expectedVersion: 0, error: ERROR,
    outputs: [{ ...f.plan.outputs[0]!, result: { status: "failed", error: ERROR }, late: false }] };
}
/** Independently seed a terminal record to isolate receipt/replay from an earlier finish implementation.
 * @throws {Error} On a fixture SQL failure.
 */
async function terminalFixture(f: ExecutionFixture): Promise<void> {
  const current = (await view(f)).record; const r: MiniToolExecutionRecord = { ...current, status: "failed", resultVersion: 1, error: ERROR, outputs: failure(f).outputs };
  await pg`UPDATE tasks SET status='failed',completed_at=clock_timestamp(),error_message='internal' WHERE id=${f.taskId}`; await storeExecutionFixture(pg, f, r);
}
/** Read the one original step and its typed execution state, never as a public GET implementation.
 * @throws {Error} When the fixture's original step is absent.
 */
async function step(f: ExecutionFixture): Promise<Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number]> {
  // Preparation container_job rows precede the one generate step (E3b).
  const steps = (await upstreamStepRepo.listSteps(f.taskId)).filter((row) => row.kind === "generate"); expect(steps).toHaveLength(1); return steps[0]!;
}

describe("terminal cleanup proves original call identities independently of actual amounts", () => {
  it("C01 closes resolved P at cleanup while its actual cost is still pending and its hold remains held", async () => {
    const f = await seed(); await returned(f); await cleanup(f); const v = await view(f);
    expect(v.record.status).toBe("failed"); expect(v.period?.consumptionSetComplete).toBe(true); expect(v.hold).toBe("held");
    expect(v.record.usage).toEqual([{ consumptionKey: miniToolConsumptionRecordSchema.parse((await step(f)).output.miniToolConsumption).consumptionKey, state: "pending", chargeTo: "user", costUsd: null, credits: null }]);
    expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("C02 settles the original real expense once after cleanup with no run pickup", async () => {
    const f = await seed(); const p = await returned(f); await cleanup(f); const before = await view(f);
    const lookup = vi.fn(async (_input: MiniToolConsumptionLookupInput) => ({ state: "known" as const, costUsd: 0.3, costSource: "generation_lookup" as const, raw: { bill: 0.3 } }));
    if (!before.period) throw new Error("Missing original waiting cycle");
    const recorded = await runMiniToolSettlement({ taskId: f.taskId, settlementVersion: before.period.version }, lookup);
    if (!recorded.nextWake) throw new Error("Original recorded expense has no terminal wake");
    const settled = await runMiniToolSettlement({ taskId: f.taskId, settlementVersion: recorded.nextWake.settlementVersion }, lookup);
    expect(settled.charge).toMatchObject({ state: "settled", credits: 30, first: true }); expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0]).toMatchObject({ consumption: { identity: { kind: "provider", provider: "wavespeed", predictionId: P } } });
    const after = await view(f); expect(after.hold).toBe("released"); expect(after.period?.state).toBe("settled"); expect(media(after.record)).toEqual(media(before.record));
    const c = miniToolConsumptionRecordSchema.parse((await step(f)).output.miniToolConsumption); expect(c).toMatchObject({ state: "recorded", costUsd: 0.3, credits: 30 });
    const usage = await pg`SELECT operation_key,cost_usd::float8,credits::float8 FROM agent_usage_records WHERE operation_key=${c.consumptionKey}`;
    expect([...usage]).toEqual([{ operation_key: c.consumptionKey, cost_usd: 0.3, credits: 30 }]);
    expect(await settleMiniToolCharge(f.taskId)).toMatchObject({ state: "settled", credits: 30, first: false });
    const ledger = await pg`SELECT entry_type,amount::float8 FROM credit_ledger WHERE reference_id=${f.taskId}`; expect([...ledger]).toEqual([{ entry_type: "spend", amount: -30 }]);
    expect((await step(f)).id).toBe(p.stepId); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it.each(["known", "recorded"] as const)("C03 terminal replay proves resolved identities with %s cost without changing media", async (state) => {
    const f = await seed(); const p = await returned(f); await terminalFixture(f); await known(f, p, state === "recorded"); const before = await view(f);
    await runMiniToolExecutionTask(job(f), "token"); const after = await view(f); expect(after.period?.consumptionSetComplete).toBe(true); expect(media(after.record)).toEqual(media(before.record));
    expect(after.record.usage).toEqual(before.record.usage); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it.each(["no P", "another P pending", "another P recorded"])("C04 keeps unknown identities open despite %s", async (state) => {
    const f = await seed(); const p = await prepare(f, state === "no P" ? 1 : 2);
    if (state !== "no P") await identity(f, p); if (state === "another P recorded") await known(f, p, true);
    await cleanup(f); expect((await view(f)).period?.consumptionSetComplete).toBe(false); expect((await view(f)).hold).toBe("held");
    expect(await settleMiniToolCharge(f.taskId)).toEqual({ state: "pending" }); expect(runPrediction).not.toHaveBeenCalled();
  });
  it("C05 original last receipt closes under its owner without any run replay or new submit", async () => {
    const f = await seed(); const p = await prepare(f); await cleanup(f); const before = await view(f); expect(before.period?.consumptionSetComplete).toBe(false);
    await identity(f, p); const after = await view(f); expect(after.period?.consumptionSetComplete).toBe(true); expect(media(after.record)).toEqual(media(before.record));
    const s = await step(f); expect(s.predictionId).toBe(P); expect(miniToolStepStateSchema.parse(s.output.miniToolStep).deadlineAt).toBe(p.deadlineAt);
    expect(miniToolConsumptionRecordSchema.parse(s.output.miniToolConsumption)).toMatchObject({ state: "pending", costUsd: null, credits: null });
    await identity(f, p); expect((await view(f)).record.usage).toHaveLength(1); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("C06 does not mistake one canonical P for resolution of another original attempt", async () => {
    const f = await seed(); const p = await prepare(f, 2); await cleanup(f); await identity(f, p, 0);
    expect((await view(f)).period?.consumptionSetComplete).toBe(false); await identity(f, p, 1); expect((await view(f)).period?.consumptionSetComplete).toBe(true); expect((await view(f)).record.usage).toHaveLength(1);
  });
  it("C06/C07 retains identity conflict, original P and actual recorded cost without closing", async () => {
    const f = await seed(); const p = await prepare(f); await identity(f, p);
    const conflict = await recordMiniToolStepIdentity({ taskId: f.taskId, stepId: p.stepId, attemptId: p.attemptIds[0]!, predictionId: "different-observed-P" }); expect(conflict.conflict).toBe(true);
    await known(f, p, true); await cleanup(f); const s = await step(f);
    expect(s.predictionId).toBe(P); expect(miniToolStepStateSchema.parse(s.output.miniToolStep).conflicts).toMatchObject([{ kind: "identity", canonicalId: P, candidateId: "different-observed-P" }]);
    expect((await view(f)).period?.consumptionSetComplete).toBe(false); expect((await view(f)).record.usage).toMatchObject([{ state: "recorded", costUsd: 0.3, credits: 30 }]); expect((await view(f)).hold).toBe("held");
  });
  it("C06 preserves an owned closed-identity reconciliation fact without treating the set as complete", async () => {
    const f = await seed(); const p = await returned(f); const state = miniToolStepStateSchema.parse((await step(f)).output.miniToolStep);
    // This owned stored-fact input does not assert a second real provider call or assign it a fee.
    state.conflicts.push({ kind: "closed_identity", attemptId: p.attemptIds[0]!, candidateId: "unreconciled-old-receipt" });
    await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolStep}',${pg.json(state)}) WHERE id=${p.stepId}`;
    await cleanup(f); expect((await view(f)).period?.consumptionSetComplete).toBe(false); expect((await view(f)).hold).toBe("held");
    expect(miniToolStepStateSchema.parse((await step(f)).output.miniToolStep).conflicts).toEqual(state.conflicts);
  });
  it.each(["attempt", "body", "fingerprint", "scope", "preparedAt"])("C07 rejects an invalid original receipt proof at %s without closing or replacing facts", async (bad) => {
    const f = await seed(); const p = await prepare(f); await terminalFixture(f); const s = await step(f); const state = miniToolStepStateSchema.parse(s.output.miniToolStep);
    if (bad === "body") state.requestBody = { ...state.requestBody, video: "https://changed.example.test/source.mp4" };
    else if (bad === "fingerprint") state.attempts[0]!.requestFingerprint = "e".repeat(64);
    else if (bad === "scope") state.scope.itemIndex = 1;
    else if (bad === "preparedAt") state.attempts[0]!.preparedAt = new Date(p.deadlineAt).toISOString().replace("Z", "000Z");
    if (bad !== "attempt") await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolStep}',${pg.json(state)}) WHERE id=${p.stepId}`;
    const before = await executionSnapshot(pg, f); const beforeStep = await step(f);
    await expect(recordMiniToolStepIdentity({ taskId: f.taskId, stepId: p.stepId, attemptId: bad === "attempt" ? randomUUID() : p.attemptIds[0]!, predictionId: P })).rejects.toBeInstanceOf(Error);
    expect(await executionSnapshot(pg, f)).toEqual(before); expect(await step(f)).toEqual(beforeStep); expect((await view(f)).period?.consumptionSetComplete).toBe(false); expect((await view(f)).hold).toBe("held");
  });
  it("C08 fences new terminal submit while retaining a non-submitting read of the original held attempt", async () => {
    const f = await seed(); const p = await prepare(f); await terminalFixture(f); const original = await step(f);
    const common = { taskId: f.taskId, stepId: p.stepId, deadlineAt: p.deadlineAt, requestBody: { ...f.plan.body }, chargeTo: "user" as const };
    const held = await beginMiniToolStepAttempt({ ...common, attemptId: p.attemptIds[0]! }); expect(held.shouldSubmit).toBe(false); expect(held.attempt?.attemptId).toBe(p.attemptIds[0]);
    expect(await beginMiniToolStepAttempt({ ...common, attemptId: randomUUID() })).toMatchObject({ shouldSubmit: false, attempt: null }); expect(await step(f)).toEqual(original); expect(runPrediction).not.toHaveBeenCalled();
  });
  it.each(["not_sent", "rejected"] as const)("C09 closes a proven empty %s set and settles zero without a cost lookup", async (proof) => {
    const f = await seed(); const p = await prepare(f); await failMiniToolStep({ taskId: f.taskId, stepId: p.stepId, error: { code: proof }, attempt: { attemptId: p.attemptIds[0]!, proof } });
    await cleanup(f); const v = await view(f); if (!v.period) throw new Error("Missing terminal empty cycle");
    const lookup = vi.fn(); const settled = await runMiniToolSettlement({ taskId: f.taskId, settlementVersion: v.period.version }, lookup);
    expect(settled.charge).toMatchObject({ state: "settled", credits: 0, first: true }); expect(lookup).not.toHaveBeenCalled(); expect((await view(f)).hold).toBe("released");
    const ledger = await pg`SELECT id FROM credit_ledger WHERE reference_id=${f.taskId}`; expect([...ledger]).toEqual([]);
  });
  it.each([
    { policy: "platform", costState: "pending" }, { policy: "platform", costState: "known" },
    { policy: "zero multiplier", costState: "pending" }, { policy: "zero multiplier", costState: "known" },
  ] as const)("C10 proves identity independently of $policy and $costState amount", async ({ policy, costState }) => {
    const f = await seed(); let p: Prepared;
    if (policy === "platform") p = await returned(f, "platform");
    else {
      // The existing producer accepts a nonnegative first policy. Deployment CREDIT_MULTIPLIER remains positive.
      const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing stored identity fixture");
      await upstreamStepRepo.markSubmitted(s.id, P);
      await openMiniToolConsumption({ taskId: f.taskId, stepId: s.id, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, chargeTo: "user", creditMultiplier: 0, containerPricing: null });
      p = { stepId: s.id, attemptIds: [], deadlineAt: 0 };
    }
    const claim = costState === "known" ? await known(f, p) : null;
    await cleanup(f); expect((await view(f)).period?.consumptionSetComplete).toBe(true);
    const c = miniToolConsumptionRecordSchema.parse((await step(f)).output.miniToolConsumption); expect(c.costUsd).toBe(costState === "known" ? 0.3 : null); expect(c.credits).toBeNull();
    if (claim) {
      await recordMiniToolConsumption({ taskId: f.taskId, stepId: p.stepId, identity: c.identity, claim });
      expect(miniToolConsumptionRecordSchema.parse((await step(f)).output.miniToolConsumption)).toMatchObject({ costUsd: 0.3, credits: 0, state: "recorded" });
    }
  });
  it("C11 terminal proof preserves the exact active lease and accepts its original lookup answer", async () => {
    const f = await seed(); const p = await returned(f); const before = await view(f); if (!before.period) throw new Error("Missing pending period");
    const owned = await claimMiniToolSettlement({ taskId: f.taskId, settlementVersion: before.period.version }); if (!owned) throw new Error("Missing actual lease");
    await cleanup(f); expect((await view(f)).period).toMatchObject({ state: "checking", version: owned.claim.version, leaseToken: owned.claim.leaseToken, leaseUntil: owned.leaseUntil, consumptionSetComplete: true });
    await confirmMiniToolConsumption({ taskId: f.taskId, stepId: p.stepId, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, claim: owned.claim, costUsd: 0.3, costSource: "generation_lookup", raw: { originalLease: true } });
    expect(miniToolConsumptionRecordSchema.parse((await step(f)).output.miniToolConsumption)).toMatchObject({ state: "known", costUsd: 0.3, credits: null });
  });
  it.each(["begin first", "terminal first"] as const)("C12 observes the actual task-lock ordering for %s", async (order) => {
    const f = await seed(); const [s] = await upstreamStepRepo.ensureSteps(f.taskId, [{ kind: "generate", endpoint: f.plan.provider.model_id, itemIndex: 0 }]); if (!s) throw new Error("Missing concurrent step");
    const [time] = await pg<{ deadline: number }[]>`SELECT (extract(epoch FROM created_at)*1000)::float8 + ${getNodeTaskConfig().default_budget_ms} AS deadline FROM tasks WHERE id=${f.taskId}`; if (!time) throw new Error("Missing original budget");
    const input = { taskId: f.taskId, stepId: s.id, attemptId: randomUUID(), deadlineAt: Math.trunc(time.deadline), requestBody: { ...f.plan.body }, chargeTo: "user" as const };
    let entered!: () => void; let release!: () => void; const ready = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
    const owner = pg.begin(async (tx) => { await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; entered(); await gate; }); await ready;
    let beginning: ReturnType<typeof beginMiniToolStepAttempt> | null = null; let finishing: ReturnType<typeof miniToolExecutionService.finishMiniToolExecution> | null = null;
    if (order === "begin first") beginning = beginMiniToolStepAttempt(input); else finishing = miniToolExecutionService.finishMiniToolExecution(f.taskId, failure(f));
    void (beginning ?? finishing)!.catch(() => undefined);
    try {
      await waitUntilBlockedOn(pg, ["tasks", "for update"], 1);
      if (order === "begin first") finishing = miniToolExecutionService.finishMiniToolExecution(f.taskId, failure(f)); else beginning = beginMiniToolStepAttempt(input);
      void (order === "begin first" ? finishing : beginning)!.catch(() => undefined);
      await waitUntilBlockedOn(pg, ["tasks", "for update"], 2); release(); await owner;
      const [started] = await Promise.all([beginning!, finishing!]); expect(started.shouldSubmit).toBe(order === "begin first");
      expect((await view(f)).record.status).toBe("failed"); expect((await view(f)).period?.consumptionSetComplete).toBe(order === "terminal first");
    } finally { release(); await owner; await Promise.allSettled([beginning, finishing].filter((p) => p !== null)); }
  });
  it("C13 rolls terminal status, public media and complete proof back together when closure persistence fails", async () => {
    const f = await seed(); await returned(f); const before = await executionSnapshot(pg, f); const beforeStep = await step(f);
    await pg.unsafe(`CREATE FUNCTION reject_terminal_closure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.result#>>'{settlement,consumptionSetComplete}'='true' THEN RAISE EXCEPTION 'fixture_closure_failed'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_terminal_closure BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_terminal_closure()");
    try { await expect(miniToolExecutionService.finishMiniToolExecution(f.taskId, failure(f))).rejects.toMatchObject({ cause: { message: expect.stringContaining("fixture_closure_failed") } }); }
    finally { await pg.unsafe("DROP TRIGGER reject_terminal_closure ON tasks"); await pg.unsafe("DROP FUNCTION reject_terminal_closure()"); }
    expect(await executionSnapshot(pg, f)).toEqual(before); expect(await step(f)).toEqual(beforeStep); expect((await view(f)).hold).toBe("held"); expect((await view(f)).billed).toBeNull();
  });
  it.each(["generate after a done preparation", "preparation failed with no generate"] as const)("C15 cleanup closes a run whose %s", async (kind) => {
    const f = await seed(); const jobs = fakeIngestJobs();
    if (kind === "generate after a done preparation") runPrediction.mockImplementation(async (_connection, _model, _body, resume) => { await resume.persistTaskId(P); throw new UpstreamTaskFailed("wavespeed", "fixture refusal"); });
    else for (let attempt = 1; attempt <= f.plan.preparation.chunkRetries + 1; attempt += 1) {
      jobs.scripted.set(videoContainerJobId({ kind: "prep", taskId: f.taskId, input: 0, attempt }), { schemaVersion: 2, state: "failed", outputs: [], reason: "tool_failed", usage: { wallMs: 500, cpuUsec: 1000000 } });
    }
    // The worker dies at its terminal commit, so only the queue cleanup can end the run.
    await pg.unsafe(`CREATE FUNCTION reject_terminal_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.taskId}'::uuid AND NEW.status='failed' THEN RAISE EXCEPTION 'fixture_worker_died'; END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER reject_terminal_status BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_terminal_status()");
    try { await runMiniToolExecutionTask(job(f), "token").catch(() => null); }
    finally { await pg.unsafe("DROP TRIGGER reject_terminal_status ON tasks"); await pg.unsafe("DROP FUNCTION reject_terminal_status()"); }
    expect((await executionSnapshot(pg, f)).status).toBe("running");
    const rows = await upstreamStepRepo.listSteps(f.taskId);
    expect(rows[0]).toMatchObject({ kind: "container_job", position: 0 });
    expect(rows.filter((row) => row.kind === "generate").map((row) => row.position)).toEqual(kind === "generate after a done preparation" ? [1] : []);
    await cleanup(f); const v = await view(f); expect(v.record.status).toBe("failed"); expect(v.period?.consumptionSetComplete).toBe(true);
  });
  it("C14 does not reclassify an original typed result conflict as an unknown call identity", async () => {
    const f = await seed(); const p = await returned(f);
    await expect(recordMiniToolStepResult({ taskId: f.taskId, stepId: p.stepId, identity: { kind: "provider", provider: "wavespeed", predictionId: P }, outcome: "done", result: ["https://provider.example.test/other.webm"] },
      { kind: "generate", parse: () => ({ providerURL: "https://provider.example.test/other.webm" }) })).rejects.toBeInstanceOf(Error);
    await cleanup(f); expect((await view(f)).period?.consumptionSetComplete).toBe(true);
    expect(miniToolStepStateSchema.parse((await step(f)).output.miniToolStep).conflicts).toEqual([{ kind: "result", result: { providerURL: "https://provider.example.test/other.webm" } }]);
  });
});

/** Narrow actual logger arguments without serializing or replacing their original errors.
 * @throws {never} Never.
 */
function captured(value: unknown): value is Captured {
  return typeof value === "object" && value !== null && "err" in value && value.err instanceof Error
    && "ctx" in value && typeof value.ctx === "object" && value.ctx !== null;
}
/** Produce a real receipt SQL exception and retain the original logger Error object/cause/stack.
 * @throws {Error} When actual execution, logging or fixture cleanup fails.
 */
async function receiptFailure(f: ExecutionFixture): Promise<{ stepId: string; error: Error }> {
  const p = await returned(f); const errorLog = vi.spyOn(logger, "error");
  storeFromUrl.mockResolvedValue({ assetId: f.registered.assetId, fileUrl: f.registered.canonicalURL, kind: "video", coverUrl: null,
    width: 960, height: 540, durationSeconds: 5.013, mimeType: "video/webm", sizeBytes: 1588436 });
  await pg.unsafe(`CREATE FUNCTION reject_private_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${f.taskId}'::uuid AND NEW.output ? 'miniToolAsset:0' THEN RAISE EXCEPTION 'fixture_private_receipt_sql_params'; END IF; RETURN NEW; END $$`);
  await pg.unsafe("CREATE TRIGGER reject_private_receipt BEFORE UPDATE ON task_upstream_steps FOR EACH ROW EXECUTE FUNCTION reject_private_receipt()");
  try {
    await runMiniToolExecutionTask(job(f), "token");
    const original = errorLog.mock.calls.map(([entry]) => entry).filter(captured).find((entry) => entry.err.message.includes("Failed query"));
    if (!original) throw new Error("The actual receipt PG error was not logged");
    expect(original.ctx).toMatchObject({ taskId: f.taskId, stepId: p.stepId, phase: expect.any(String) });
    expect(original.err.cause).toMatchObject({ message: expect.stringContaining("fixture_private_receipt_sql_params") }); expect(original.err.stack).toContain("Error");
    expect(runPrediction).not.toHaveBeenCalled(); return { stepId: p.stepId, error: original.err };
  } finally { errorLog.mockRestore(); await pg.unsafe("DROP TRIGGER reject_private_receipt ON task_upstream_steps"); await pg.unsafe("DROP FUNCTION reject_private_receipt()"); }
}
/** Read the real target task row after notification, without a node/content mock.
 * @throws {Error} On a fixture SQL failure.
 */
async function node(f: ExecutionFixture): Promise<unknown> {
  const rows = await pg`SELECT status,error_message FROM node_tasks WHERE task_id=${f.taskId}`; expect(rows).toHaveLength(1); return rows[0];
}
/** Read the production project endpoint through a real authenticated Redis session.
 * @throws {Error} When authentication or public parsing fails.
 */
async function get(f: ExecutionFixture): Promise<{ response: Response; record: MiniToolExecutionRecord; wire: string }> {
  const token = randomBytes(24).toString("hex"); tokens.push(token); await setSession(getRedis(), token, f.viewerId);
  const response = await app.request(`/api/v1/projects/${f.projectId}/mini-tool-runs/${f.taskId}`, { headers: { Cookie: `${sessionCookieName()}=${token}` } });
  expect(response.status).toBe(200); const raw: unknown = await response.json();
  if (typeof raw !== "object" || raw === null || !("data" in raw)) throw new Error("Public response has no record envelope");
  return { response, record: miniToolExecutionRecordSchema.parse(raw.data), wire: JSON.stringify(raw) };
}
/** Create the original internal parser exception without throwing during fixture setup.
 * @throws {Error} When the deliberately invalid parser fixture unexpectedly succeeds.
 */
function parseError(): Error {
  const parsed = miniToolExecutionRecordSchema.safeParse({ internalFixtureNumber: "private" });
  if (parsed.success) throw new Error("Invalid internal parser fixture succeeded"); return parsed.error;
}

describe("planned error projection keeps internal diagnostics in the application logger", () => {
  it("E01 real receipt PG failure stores internal in parent and failed slot, keeping original P/expense", async () => {
    const f = await seed(); const original = await receiptFailure(f); const v = await view(f);
    expect(v.record.error).toEqual({ code: "internal" }); expect(v.record.outputs[0]!.result).toEqual({ status: "failed", error: { code: "internal" } });
    expect(v.record.status).toBe("failed"); expect(v.hold).toBe("held"); expect(v.record.usage).toMatchObject([{ state: "pending", costUsd: null, credits: null }]);
    expect((await step(f)).predictionId).toBe(P); expect(original.error.message).toContain("Failed query");
  });
  it("E01 real receipt PG failure sends only internal to the actual target row", async () => {
    const f = await seed(); await receiptFailure(f); expect(await node(f)).toEqual({ status: "failed", error_message: "internal" });
  });
  it("E10 GET remains a successful project read whose failure data contains no private receipt diagnostics", async () => {
    const f = await seed(); await receiptFailure(f); const result = await get(f); expect(result.record.error).toEqual({ code: "internal" });
    expect(result.record.outputs[0]!.result).toEqual({ status: "failed", error: { code: "internal" } });
    for (const text of ["Failed query", "task_upstream_steps", "fixture_private_receipt_sql_params", "miniToolAsset:0", "sourceKey", "requestBody"]) expect(result.wire).not.toContain(text);
  });
  it.each([
    { name: "ordinary Error", thrown: new Error("fixture_internal_sql_params") },
    { name: "unknown object", thrown: { query: "fixture_unknown_query", params: ["private"] } },
    { name: "SyntaxError", thrown: new SyntaxError("fixture_internal_parse_details") },
    { name: "ZodError", thrown: parseError() },
    { name: "forged AppError name", thrown: Object.assign(new Error("fixture_private_fake_validation"), { name: "ValidationError" }) },
  ])("E02/E03 makes $name internal while preserving the original thrown diagnostic object", async ({ thrown }) => {
    const f = await seed(); await returned(f); storeFromUrl.mockRejectedValue(thrown); const errors = vi.spyOn(logger, "error");
    try {
      await runMiniToolExecutionTask(job(f), "token");
      expect(errors.mock.calls.some(([entry]) => typeof entry === "object" && entry !== null && "err" in entry && entry.err === thrown)).toBe(true);
      expect((await view(f)).record.error).toEqual({ code: "internal" }); expect(await node(f)).toEqual({ status: "failed", error_message: "internal" });
    } finally { errors.mockRestore(); }
  });
  it.each(["DeadlinePassed", "original D expired"] as const)("E04 retains original expired classification for %s", async (kind) => {
    const f = await seed();
    if (kind === "DeadlinePassed") { await returned(f); storeFromUrl.mockRejectedValue(new DeadlinePassed()); }
    else {
      await pg`UPDATE tasks SET created_at=clock_timestamp() - interval '3 hours' WHERE id=${f.taskId}`;
      await pg`UPDATE node_tasks SET started_at=clock_timestamp() - interval '3 hours' WHERE task_id=${f.taskId}`;
    }
    await runMiniToolExecutionTask(job(f), "token"); expect((await view(f)).record.error).toEqual({ code: "expired" }); expect(await node(f)).toEqual({ status: "expired", error_message: "expired" }); expect(runPrediction).not.toHaveBeenCalled();
  });
  it.each([
    { name: "ValidationError", thrown: new ValidationError("fixture_public_validation") },
    { name: "ConflictError", thrown: new ConflictError("fixture_public_conflict") },
  ])("E05 preserves deliberately public $name business text", async ({ thrown }) => {
    const f = await seed(); await returned(f); storeFromUrl.mockRejectedValue(thrown); await runMiniToolExecutionTask(job(f), "token");
    expect((await view(f)).record.error).toEqual({ code: "mini_tool_failed", message: thrown.message }); expect(await node(f)).toEqual({ status: "failed", error_message: thrown.message });
    expect(JSON.stringify((await view(f)).record.error)).not.toContain("stack");
  });
  it.each(["fixture_provider_refusal", "provider rejected input containing SELECT or params"])("E06/E07 preserves actual UpstreamTaskFailed words: %s", async (words) => {
    const f = await seed(); const original = new UpstreamTaskFailed("wavespeed", words);
    runPrediction.mockImplementation(async (_connection, _model, _body, resume) => { await resume.persistTaskId(P); throw original; });
    await runMiniToolExecutionTask(job(f), "token"); expect((await view(f)).record.error).toEqual({ code: "mini_tool_failed", message: `wavespeed task failed: ${words}` });
    expect(runPrediction).toHaveBeenCalledTimes(1); expect(storeFromUrl).not.toHaveBeenCalled(); expect((await step(f)).predictionId).toBe(P);
  });
  it("E08 treats a bare QueueEvents reason as internal and retains its original diagnostic in the logger", async () => {
    const f = await seed(); await returned(f); const reason = "Failed query: fixture SQL params"; const errors = vi.spyOn(logger, "error");
    try {
      await cleanup(f, reason); expect((await view(f)).record.error).toEqual({ code: "internal" }); expect(await node(f)).toEqual({ status: "failed", error_message: "internal" });
      expect(errors.mock.calls.some(([entry]) => {
        if (typeof entry !== "object" || entry === null) return false;
        if ("reason" in entry && entry.reason === reason) return true;
        if ("err" in entry && entry.err instanceof Error && entry.err.message === reason) return true;
        return "ctx" in entry && typeof entry.ctx === "object" && entry.ctx !== null && "reason" in entry.ctx && entry.ctx.reason === reason;
      })).toBe(true);
    } finally { errors.mockRestore(); }
  });
  it.each(["safe failed", "registered completed"] as const)("E09 terminal queue replay preserves %s instead of replacing it with a raw reason", async (kind) => {
    const f = await seed(); await returned(f);
    if (kind === "safe failed") await miniToolExecutionService.finishMiniToolExecution(f.taskId, failure(f));
    else {
      await upstreamStepRepo.recordInline((await step(f)).id, { "miniToolAsset:0": f.registered.assetId }, 0);
      await miniToolExecutionService.finishMiniToolExecution(f.taskId, { ...failure(f), error: null, outputs: [{ ...f.plan.outputs[0]!, result: f.registered, late: false }] });
    }
    const before = media((await view(f)).record); await cleanup(f, "Failed query: do not replace the original outcome"); expect(media((await view(f)).record)).toEqual(before); expect(runPrediction).not.toHaveBeenCalled(); expect(storeFromUrl).not.toHaveBeenCalled();
  });
  it("E11 leaves successful provider/canonical URL values containing SQL-like words unchanged", async () => {
    const f = await seed(); const key = `video/SELECT/params/${f.registered.assetId}.webm`; const url = `https://assets.example.test/${key}`;
    await pg`UPDATE studio_assets SET storage_key=${key},file_url=${url} WHERE id=${f.registered.assetId}`;
    runPrediction.mockImplementation(async (_connection, _model, _body, resume) => { await resume.persistTaskId(P); return { taskId: P, outputs: [TEMP] }; });
    storeFromUrl.mockResolvedValue({ assetId: f.registered.assetId, fileUrl: url, kind: "video", coverUrl: null, width: 960, height: 540, durationSeconds: 5.013, mimeType: "video/webm", sizeBytes: 1588436 });
    await runMiniToolExecutionTask(job(f), "token"); const v = await view(f); expect(v.record.status).toBe("completed"); expect(v.record.error).toBeNull();
    expect(v.record.outputs[0]!.result).toEqual({ ...f.registered, canonicalURL: url }); expect(storeFromUrl).toHaveBeenCalledExactlyOnceWith(TEMP, expect.any(Object));
  });
});
