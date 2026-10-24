// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import crypto from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getNodeTaskConfig, initCore } from "@breatic/core";
import { miniToolConsumptionKey, type MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import { insertUsageRecord } from "@domain/credit/agentUsage.repo.js";
import type { UsageRow } from "@domain/credit/usage-recorder.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

interface Consumption {
  schemaVersion: 1;
  consumptionKey: string;
  identity: MiniToolConsumptionIdentity;
  state: "pending" | "known" | "recorded";
  creditMultiplier: number;
  chargeTo: "user" | "platform";
  costUsd: number | null;
  costSource: "generation_lookup" | "computed" | null;
  raw: { deductUsd: number; refundUsd: number } | { wallMs: number; cpuUsec: number | null } | null;
  credits: number | null;
  containerPricing: {
    configVersion: string;
    size: { vcpu: number; memory_gib: number; disk_gb: number };
    prices: { vcpu_second_usd: number; memory_gib_second_usd: number; disk_gb_second_usd: number };
  } | null;
}

interface RecordInput {
  taskId: string;
  stepId: string;
  identity: MiniToolConsumptionIdentity;
  claim?: { version: number; leaseToken: string };
}

interface Settlement {
  version: number;
  state: "waiting" | "checking" | "idle" | "settled";
  pendingConsumptionKeys: string[];
  nextAttemptAt: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  lastError: string | null;
}

interface Fixture extends RecordInput {
  userId: string;
  projectId: string;
  nodeTaskId: string;
  consumption: Consumption;
  settlement: Settlement;
}

interface SeedOptions {
  taskId?: string;
  stepId?: string;
  identity?: MiniToolConsumptionIdentity;
  state?: Consumption["state"];
  parentStatus?: "failed" | "running" | "completed";
  chargeTo?: Consumption["chargeTo"];
  costUsd?: number;
  creditMultiplier?: number;
  checking?: boolean;
}

interface Snapshot {
  task: {
    status: string; billed_at: string | null; billed_credits: number | null;
    result: { manifest: unknown; settlement: Settlement; preserved: unknown };
    params: unknown; completed_at: string | null; created_at: string; updated_at: string;
  };
  step: { status: string; prediction_id: string | null; created_at: string; updated_at: string; output: { miniToolConsumption: Consumption; preservedOutput: unknown } };
  node: { started_at: string; budget_ms: number; status: string; settled_at: string | null; updated_at: string };
  usage: { operation_key: string; feature: string; source: string; provider: string; cost_usd: string; credits: string; cost_source: string }[];
}

const FIXED_TASK = "10000000-0000-4000-8000-000000000001";
const FIXED_STEP = "20000000-0000-4000-8000-000000000001";
const FIXED_IDENTITY = { kind: "provider", provider: "wavespeed", predictionId: "prediction-001" } as const;
const FIXED_KEY = "cdae9c015bd2ab630eb20c226b748a94cc5c8515170d1a292fff04d60d9caec7";
const T0 = "2026-10-24T09:03:03.100001Z";
const MANIFEST = { resultVersion: 3, outputs: [{ outputIndex: 0, registeredUrl: "https://assets.test.invalid/kept.mp4" }] };
let rawPg: ReturnType<typeof createPgClient>;

beforeAll(() => {
  initCore({ ...process.env, CREDIT_MULTIPLIER: "9", PAYMENT_ENABLED: "false" });
  // Drizzle configures its own client's JSON serializers. Keep fixture SQL on
  // an independent pool so sql.json retains postgres.js's normal object codec.
  rawPg = createPgClient(inject("DATABASE_URL"), { name: "mini-tool-consumption-fixtures", max: 4 });
});
afterAll(async () => {
  await rawPg.end();
});
beforeEach(() => {
  initCore({ ...process.env, CREDIT_MULTIPLIER: "9", PAYMENT_ENABLED: "false" });
});

/**
 * Reach the future entry through an existing module so RED is a missing API assertion.
 * @param input - Persisted scope, actual upstream identity and optional lookup lease.
 * @returns The persisted consumption reported by the production entry.
 * @throws {Error} When the entry is absent or recording is rejected.
 */
async function record(input: RecordInput): Promise<Consumption> {
  const entry: unknown = Reflect.get(domain, "recordMiniToolConsumption");
  expect(entry, "domain exports recordMiniToolConsumption").toBeTypeOf("function");
  return (entry as (request: RecordInput) => Promise<Consumption>)({
    taskId: input.taskId, stepId: input.stepId, identity: input.identity,
    ...(input.claim === undefined ? {} : { claim: input.claim }),
  });
}

/**
 * Seed a failed or running parent, its original node deadline and one real step.
 * @param options - The independent cost/state fixture.
 * @returns The stored scope and immutable consumption facts.
 * @throws {Error} When database fixture setup fails.
 */
async function seed(options: SeedOptions = {}): Promise<Fixture> {
  const taskId = options.taskId ?? crypto.randomUUID();
  const stepId = options.stepId ?? crypto.randomUUID();
  const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const spaceId = crypto.randomUUID();
  const nodeTaskId = crypto.randomUUID();
  const identity = options.identity ?? { kind: "provider", provider: "wavespeed", predictionId: `prediction-${crypto.randomUUID()}` };
  const state = options.state ?? "known";
  const costUsd = state === "pending" ? null : options.costUsd ?? (identity.kind === "provider" ? 0.000055 : 0.00001256);
  const consumption: Consumption = {
    schemaVersion: 1, consumptionKey: await miniToolConsumptionKey({ taskId, stepId, identity }), identity,
    state, creditMultiplier: options.creditMultiplier ?? 2, chargeTo: options.chargeTo ?? "user",
    costUsd, costSource: state === "pending" ? null : identity.kind === "provider" ? "generation_lookup" : "computed",
    raw: costUsd === null ? null : identity.kind === "provider" ? { deductUsd: costUsd, refundUsd: 0 } : { wallMs: 1000, cpuUsec: 100000 },
    credits: state === "recorded" ? (options.chargeTo === "platform" ? 0 : costUsd! * 100 * (options.creditMultiplier ?? 2)) : null,
    containerPricing: identity.kind === "provider" ? null : {
      configVersion: "cloudflare-2026-10-07",
      size: { vcpu: 0.5, memory_gib: 4, disk_gb: 8 },
      prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
    },
  };
  const settlement: Settlement = {
    version: 7, state: options.checking ? "checking" : "waiting",
    pendingConsumptionKeys: state === "recorded" ? [] : [consumption.consumptionKey],
    nextAttemptAt: T0, leaseToken: options.checking ? crypto.randomUUID() : null,
    leaseUntil: options.checking ? "2099-01-01T00:00:00.000000Z" : null, lastError: null,
  };
  await rawPg`INSERT INTO users (id, email, email_verified) VALUES (${userId}, ${`consumption-${userId}@example.test`}, true)`;
  await rawPg`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${userId}, ${`c-${studioId}`}, 'team', 'Consumption')`;
  await rawPg`INSERT INTO projects (id, studio_id, created_by_user_id, slug, name) VALUES (${projectId}, ${studioId}, ${userId}, ${`c-${projectId}`}, 'Consumption')`;
  await rawPg`
    INSERT INTO tasks (id, user_id, project_id, space_id, task_type, mode, source, status, params, result, completed_at)
    VALUES (${taskId}, ${userId}, ${projectId}, ${spaceId}, 'mini_tool_analysis', 'append', 'mini_tool',
      ${options.parentStatus ?? "failed"}, ${rawPg.json({ immutablePlan: "kept", deadlineAt: "2026-10-24T11:03:03.100001Z" })},
      ${rawPg.json({ manifest: MANIFEST, preserved: { original: true }, settlement: { ...settlement } })}, ${T0}::text::timestamptz)
  `;
  await rawPg`
    INSERT INTO node_tasks (id, project_id, space_id, node_id, kind, action, status, started_by_user_id, started_at, settled_at, budget_ms, label, task_id)
    VALUES (${nodeTaskId}, ${projectId}, ${spaceId}, ${crypto.randomUUID()}, 'generation', 'mini_tool', 'failed', ${userId},
      ${T0}::text::timestamptz, ${T0}::text::timestamptz, ${getNodeTaskConfig().default_budget_ms}, 'analysis', ${taskId})
  `;
  await rawPg`
    INSERT INTO task_upstream_steps (id, task_id, position, kind, endpoint, status, prediction_id, output)
    VALUES (${stepId}, ${taskId}, 0, ${identity.kind === "provider" ? "generate" : "container_job"},
      ${identity.kind === "provider" ? "wavespeed-ai/sam3-video-rle" : "scene_cuts"}, 'done',
      ${identity.kind === "provider" ? identity.predictionId : null},
      ${rawPg.json({ preservedOutput: { original: true }, miniToolConsumption: { ...consumption } })})
  `;
  return { taskId, stepId, identity, userId, projectId, nodeTaskId, consumption, settlement };
}

/**
 * Read the three transaction facts and the parent's unrelated immutable state.
 * @param fixture - The persisted task/step/node scope.
 * @returns Full SQL snapshots, with timestamps kept as text.
 * @throws {Error} When the fixture is incomplete or a database read fails.
 */
async function snapshot(fixture: Fixture): Promise<Snapshot> {
  const [task] = await rawPg<Snapshot["task"][]>`
    SELECT status, billed_at::text, billed_credits, result, params, completed_at::text, created_at::text, updated_at::text FROM tasks WHERE id = ${fixture.taskId}
  `;
  const [step] = await rawPg<Snapshot["step"][]>`SELECT status, prediction_id, output, created_at::text, updated_at::text FROM task_upstream_steps WHERE id = ${fixture.stepId}`;
  const [node] = await rawPg<Snapshot["node"][]>`
    SELECT started_at::text, budget_ms, status, settled_at::text, updated_at::text FROM node_tasks WHERE id = ${fixture.nodeTaskId}
  `;
  const usage = await rawPg<Snapshot["usage"]>`
    SELECT operation_key, feature, source, provider, cost_usd::text, credits::text, cost_source
    FROM agent_usage_records WHERE operation_key = ${fixture.consumption.consumptionKey} ORDER BY id
  `;
  if (!task || !step || !node) throw new Error("Consumption fixture is incomplete");
  return { task, step, node, usage };
}

/**
 * Assert that usage bookkeeping leaves computation and existing results untouched.
 * @param before - State before recording.
 * @param after - State after recording.
 * @returns Nothing.
 * @throws {Error} When an invariant assertion fails.
 */
function assertParentPreserved(before: Snapshot, after: Snapshot): void {
  expect(after.task.status).toBe(before.task.status);
  expect(after.task.billed_at).toBeNull();
  expect(after.task.billed_credits).toBeNull();
  expect(after.task.completed_at).toBe(before.task.completed_at);
  expect(after.task.created_at).toBe(before.task.created_at);
  expect(after.task.params).toEqual(before.task.params);
  expect(after.task.result.manifest).toEqual(MANIFEST);
  expect(after.task.result.preserved).toEqual(before.task.result.preserved);
  expect(after.step.status).toBe(before.step.status);
  expect(after.step.prediction_id).toBe(before.step.prediction_id);
  expect(after.step.created_at).toBe(before.step.created_at);
  expect(after.step.output.preservedOutput).toEqual(before.step.output.preservedOutput);
  expect(after.node).toEqual(before.node);
}

describe("mini-tool consumption recording transaction", () => {
  it("exports the recording entry before exercising persistent behavior", () => {
    expect(Reflect.get(domain, "recordMiniToolConsumption")).toBeTypeOf("function");
  });

  it("records the fixed provider identity once without changing its failed parent or deadline", async () => {
    const fixture = await seed({ taskId: FIXED_TASK, stepId: FIXED_STEP, identity: FIXED_IDENTITY });
    expect(fixture.consumption.consumptionKey).toBe(FIXED_KEY);
    const before = await snapshot(fixture);
    const result = await record(fixture);
    const after = await snapshot(fixture);
    expect(result).toEqual(after.step.output.miniToolConsumption);
    expect(after.step.output.miniToolConsumption).toEqual({ ...fixture.consumption, state: "recorded", credits: expect.closeTo(0.011, 12) });
    expect(after.usage).toHaveLength(1);
    expect(after.usage[0]).toMatchObject({ operation_key: FIXED_KEY, feature: "mini_tool", source: "model", provider: "wavespeed", cost_source: "generation_lookup" });
    expect(Number(after.usage[0]!.cost_usd)).toBe(0.000055);
    expect(Number(after.usage[0]!.credits)).toBe(0.011);
    expect(after.task.result.settlement).toMatchObject({ version: 8, state: "waiting", pendingConsumptionKeys: [], leaseToken: null, leaseUntil: null });
    assertParentPreserved(before, after);
  });

  it("keeps pending cost pending without inventing zero usage", async () => {
    const fixture = await seed({ state: "pending" });
    const before = await snapshot(fixture);
    expect(await record(fixture)).toEqual(fixture.consumption);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("records explicitly confirmed zero as one usage fact", async () => {
    const fixture = await seed({ costUsd: 0 });
    await record(fixture);
    const after = await snapshot(fixture);
    expect(after.step.output.miniToolConsumption).toEqual({ ...fixture.consumption, state: "recorded", credits: 0 });
    expect(after.usage).toHaveLength(1);
    expect(Number(after.usage[0]!.cost_usd)).toBe(0);
    expect(Number(after.usage[0]!.credits)).toBe(0);
  });

  it("records platform cost while keeping user credits zero", async () => {
    const fixture = await seed({
      chargeTo: "platform",
      identity: { kind: "container", containerClass: "MiniToolContainerStd1", jobId: "people-preparation-001", chunkIndex: 0 },
    });
    await record(fixture);
    const after = await snapshot(fixture);
    expect(after.step.output.miniToolConsumption).toEqual({ ...fixture.consumption, state: "recorded", credits: 0 });
    expect(after.usage).toHaveLength(1);
    expect(Number(after.usage[0]!.cost_usd)).toBe(0.00001256);
    expect(Number(after.usage[0]!.credits)).toBe(0);
  });

  it("uses the frozen multiplier rather than the deployment's later value", async () => {
    const fixture = await seed({ costUsd: 0.4, creditMultiplier: 2 });
    const result = await record(fixture);
    expect(result.creditMultiplier).toBe(2);
    expect(result.credits).toBe(80);
    expect(Number((await snapshot(fixture)).usage[0]!.credits)).toBe(80);
  });

  it("returns a recorded consumption unchanged on repeated notifications", async () => {
    const fixture = await seed();
    const first = await record(fixture);
    const once = await snapshot(fixture);
    expect(await record(fixture)).toEqual(first);
    expect(await record(fixture)).toEqual(first);
    expect(await snapshot(fixture)).toEqual(once);
  });

  it("keeps a running parent idle once its current consumption is recorded", async () => {
    const fixture = await seed({ parentStatus: "running" });
    const before = await snapshot(fixture);
    await record(fixture);
    const after = await snapshot(fixture);
    expect(after.task.result.settlement).toMatchObject({ version: 8, state: "idle", pendingConsumptionKeys: [], nextAttemptAt: null });
    assertParentPreserved(before, after);
  });

  it("records expense after computation completed without claiming the parent's funds", async () => {
    const fixture = await seed({ parentStatus: "completed" });
    const before = await snapshot(fixture);
    await record(fixture);
    const after = await snapshot(fixture);
    expect(after.usage).toHaveLength(1);
    expect(after.task.result.settlement).toMatchObject({ version: 8, state: "waiting", pendingConsumptionKeys: [] });
    assertParentPreserved(before, after);
  });

  it("records a measured container identity with computed cost", async () => {
    const fixture = await seed({ identity: { kind: "container", containerClass: "MiniToolContainerStd1", jobId: "container-job-001", chunkIndex: 0 } });
    await record(fixture);
    const after = await snapshot(fixture);
    expect(after.usage).toHaveLength(1);
    expect(after.usage[0]).toMatchObject({ source: "container", provider: "cloudflare", cost_source: "computed" });
    expect(after.step.output.miniToolConsumption.identity).toEqual(fixture.identity);
  });

  it("rejects a changed actual upstream identity without rewriting the original fact", async () => {
    expect(Reflect.get(domain, "recordMiniToolConsumption")).toBeTypeOf("function");
    const fixture = await seed();
    const before = await snapshot(fixture);
    await expect(record({ ...fixture, identity: { kind: "provider", provider: "wavespeed", predictionId: "replacement" } })).rejects.toThrow();
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("rejects a step belonging to another parent before writing usage", async () => {
    expect(Reflect.get(domain, "recordMiniToolConsumption")).toBeTypeOf("function");
    const fixture = await seed();
    const other = await seed();
    const before = await snapshot(fixture);
    const otherBefore = await snapshot(other);
    await expect(record({ ...fixture, stepId: other.stepId, identity: other.identity })).rejects.toThrow();
    expect(await snapshot(fixture)).toEqual(before);
    expect(await snapshot(other)).toEqual(otherBefore);
  });

  it("rejects a persisted consumption key that differs from the actual scoped identity", async () => {
    expect(Reflect.get(domain, "recordMiniToolConsumption")).toBeTypeOf("function");
    const fixture = await seed();
    const corrupted = { ...fixture.consumption, consumptionKey: "f".repeat(64) };
    await rawPg`UPDATE task_upstream_steps SET output = jsonb_set(output, '{miniToolConsumption}', ${rawPg.json({ ...corrupted })}) WHERE id = ${fixture.stepId}`;
    const before = await snapshot(fixture);
    await expect(record(fixture)).rejects.toThrow();
    expect(await snapshot(fixture)).toEqual(before);
  });

  it.each(["normal", "lookup"] as const)("serializes normal and lookup recording when %s reaches the task lock first", async (first) => {
    expect(Reflect.get(domain, "recordMiniToolConsumption")).toBeTypeOf("function");
    const fixture = await seed({ checking: true });
    const claim = { version: 7, leaseToken: fixture.settlement.leaseToken! };
    const normal = { taskId: fixture.taskId, stepId: fixture.stepId, identity: fixture.identity };
    const lookup = { ...normal, claim };
    const gate = await rawPg.reserve();
    const calls: Promise<Consumption>[] = [];
    await gate`BEGIN`;
    try {
      await gate`SELECT id FROM tasks WHERE id = ${fixture.taskId} FOR UPDATE`;
      const firstCall = record(first === "normal" ? normal : lookup);
      void firstCall.catch(() => undefined);
      calls.push(firstCall);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 1);
      const secondCall = record(first === "normal" ? lookup : normal);
      void secondCall.catch(() => undefined);
      calls.push(secondCall);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 2);
    } finally {
      await gate`ROLLBACK`;
      gate.release();
      await Promise.allSettled(calls);
    }
    await Promise.all(calls);
    const after = await snapshot(fixture);
    expect(after.usage).toHaveLength(1);
    expect(after.step.output.miniToolConsumption.state).toBe("recorded");
    expect(after.task.result.settlement.pendingConsumptionKeys).toEqual([]);
    expect(after.task.result.settlement.version).toBe(8);
  });

  it.each(["version", "token", "expired", "missing_lease", "identity"] as const)("ignores a lookup answer with stale %s and writes no state", async (fault) => {
    expect(Reflect.get(domain, "recordMiniToolConsumption")).toBeTypeOf("function");
    const fixture = await seed({ checking: true });
    if (fault === "expired" || fault === "missing_lease") {
      fixture.settlement.leaseUntil = fault === "expired" ? "2000-01-01T00:00:00.000000Z" : null;
      await rawPg`UPDATE tasks SET result = jsonb_set(result, '{settlement}', ${rawPg.json({ ...fixture.settlement })}) WHERE id = ${fixture.taskId}`;
    }
    const before = await snapshot(fixture);
    const input: RecordInput = {
      taskId: fixture.taskId, stepId: fixture.stepId,
      identity: fault === "identity" ? { kind: "provider", provider: "wavespeed", predictionId: "stale-prediction" } : fixture.identity,
      claim: { version: fault === "version" ? 6 : 7, leaseToken: fault === "token" ? crypto.randomUUID() : fixture.settlement.leaseToken! },
    };
    await Promise.allSettled([record(input)]);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("uses the database clock for a valid lease even when the application clock differs", async () => {
    const fixture = await seed({ checking: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2100, 0, 1));
    try {
      await record({ taskId: fixture.taskId, stepId: fixture.stepId, identity: fixture.identity, claim: { version: 7, leaseToken: fixture.settlement.leaseToken! } });
    } finally {
      clock.mockRestore();
    }
    const after = await snapshot(fixture);
    expect(after.usage).toHaveLength(1);
    expect(after.step.output.miniToolConsumption.state).toBe("recorded");
  });

  it.each(["task_upstream_steps", "tasks"] as const)("rolls back actual usage when the subsequent %s write fails", async (table) => {
    const fixture = await seed();
    const before = await snapshot(fixture);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `test_consumption_failure_${suffix}`;
    const triggerName = `test_consumption_trigger_${suffix}`;
    const targetId = table === "tasks" ? fixture.taskId : fixture.stepId;
    // The trigger confirms INSERT happened in the same transaction before it
    // forces the later failure; a writer outside that transaction stays visible.
    await rawPg.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${targetId}'::uuid THEN
          IF EXISTS (SELECT 1 FROM agent_usage_records WHERE operation_key = '${fixture.consumption.consumptionKey}') THEN
            RAISE EXCEPTION 'forced ${table} update after usage insert';
          END IF;
          RAISE EXCEPTION 'incorrect write order before usage insert';
        END IF;
        RETURN NEW;
      END $$`);
    await rawPg.unsafe(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      await expect(record(fixture)).rejects.toMatchObject({ cause: { message: `forced ${table} update after usage insert` } });
      expect(await snapshot(fixture)).toEqual(before);
    } finally {
      await rawPg.unsafe(`DROP TRIGGER ${triggerName} ON ${table}`);
      await rawPg.unsafe(`DROP FUNCTION ${functionName}()`);
    }
    await record(fixture);
    const after = await snapshot(fixture);
    expect(after.usage).toHaveLength(1);
    expect(after.step.output.miniToolConsumption.state).toBe("recorded");
    expect(after.task.result.settlement.pendingConsumptionKeys).toEqual([]);
  });

  it("records different keys separately and keeps raw credits for one later aggregate rounding", async () => {
    const fixture = await seed();
    const secondStep = crypto.randomUUID();
    const identity = { kind: "provider", provider: "wavespeed", predictionId: "prediction-second" } as const;
    const key = await miniToolConsumptionKey({ taskId: fixture.taskId, stepId: secondStep, identity });
    const second = { ...fixture.consumption, consumptionKey: key, identity };
    await rawPg`
      INSERT INTO task_upstream_steps (id, task_id, position, kind, endpoint, status, prediction_id, output)
      VALUES (${secondStep}, ${fixture.taskId}, 1, 'generate', 'wavespeed-ai/sam3-video-rle', 'done', ${identity.predictionId},
        ${rawPg.json({ miniToolConsumption: { ...second } })})
    `;
    await rawPg`UPDATE tasks SET result = jsonb_set(result, '{settlement,pendingConsumptionKeys}', ${rawPg.json([fixture.consumption.consumptionKey, key])}) WHERE id = ${fixture.taskId}`;
    await record(fixture);
    const halfway = await snapshot(fixture);
    expect(halfway.task.result.settlement.pendingConsumptionKeys).toEqual([key]);
    await record({ taskId: fixture.taskId, stepId: secondStep, identity });
    const rows = await rawPg<{ operation_key: string; credits: string }[]>`
      SELECT operation_key, credits::text FROM agent_usage_records WHERE operation_key IN (${fixture.consumption.consumptionKey}, ${key})
    `;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.operation_key))).toEqual(new Set([fixture.consumption.consumptionKey, key]));
    expect(rows.map((row) => Number(row.credits))).toEqual([0.011, 0.011]);
    expect(rows.reduce((sum, row) => sum + Number(row.credits), 0)).toBeCloseTo(0.022, 12);
    const final = await snapshot(fixture);
    expect(final.task.billed_at).toBeNull();
    expect(final.task.result.manifest).toEqual(MANIFEST);
    expect(final.task.result.settlement).toMatchObject({ version: 9, pendingConsumptionKeys: [] });
  });

  it("keeps one raw usage fact across generated confirmed amounts and frozen multipliers", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 1, max: 5 }), async (microUsd, multiplier) => {
      const costUsd = microUsd / 1_000_000;
      const fixture = await seed({ costUsd, creditMultiplier: multiplier });
      await record(fixture);
      await record(fixture);
      const after = await snapshot(fixture);
      expect(after.usage).toHaveLength(1);
      expect(Number(after.usage[0]!.cost_usd)).toBeCloseTo(costUsd, 12);
      expect(Number(after.usage[0]!.credits)).toBeCloseTo(costUsd * 100 * multiplier, 12);
      expect(after.step.output.miniToolConsumption.credits).toBeCloseTo(costUsd * 100 * multiplier, 12);
    }), { numRuns: 12 });
  });

  it("keeps ordinary model usage appendable more than once under one operation", async () => {
    const fixture = await seed();
    const operationKey = `ordinary:${crypto.randomUUID()}`;
    const row: UsageRow = {
      operationKey, feature: "chat_turn", source: "model", actorUserId: fixture.userId,
      projectId: fixture.projectId, model: "deepseek/deepseek-v4-pro", provider: "deepseek",
      inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null,
      requestCount: 1, costUsd: 0.000055, costSource: "provider", credits: 0.011,
    };
    await insertUsageRecord(row);
    await insertUsageRecord(row);
    const [counts] = await rawPg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key = ${operationKey}`;
    expect(counts?.count).toBe(2);
  });
});
