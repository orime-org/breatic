// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
  costSource: "computed" | null;
  raw: { wallMs: number; cpuUsec: number | null } | null;
  credits: number | null;
  containerPricing: {
    configVersion: string;
    size: { vcpu: number; memory_gib: number; disk_gb: number };
    prices: { vcpu_second_usd: number; memory_gib_second_usd: number; disk_gb_second_usd: number };
  } | null;
  // A model step's cost wait (inner#1306 §11.4).
  servedBy?: string | null; costs?: unknown[]; waiting?: { lookup: unknown; cost?: unknown }[];
  known?: number; attempts?: number; windowEndsAt?: number; nextLookupAt?: number | null;
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
  consumptionSetComplete?: boolean;
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
  step: { status: string; prediction_id: string | null; created_at: string; updated_at: string; output: { miniToolConsumption: Consumption; preservedOutput: unknown; miniToolPlanJob?: unknown } };
  node: { started_at: string; budget_ms: number; status: string; settled_at: string | null; updated_at: string };
  usage: { operation_key: string; feature: string; source: string; provider: string; cost_usd: string; credits: string; cost_source: string }[];
}

const FIXED_TASK = "10000000-0000-4000-8000-000000000001";
const FIXED_STEP = "20000000-0000-4000-8000-000000000001";
const FIXED_IDENTITY = { kind: "container", containerClass: "MiniToolContainerStd1", jobId: "fixed-job", chunkIndex: 0 } as const;
// The canonical JSON digest of { schemaVersion: 1, taskId, stepId, identity }, computed independently.
const FIXED_KEY = "184cffbeeeff246777ad1f38ca2c5d5abf83aa7f5cdb6fe8c1f0e9099246feac";
const T0 = "2026-10-24T09:03:03.100001Z";
const MANIFEST = { resultVersion: 3, outputs: [{ outputIndex: 0, registeredUrl: "https://assets.test.invalid/kept.mp4" }] };
let rawPg: ReturnType<typeof createPgClient>;

beforeAll(() => {
  initCore({ ...process.env, CREDIT_MULTIPLIER: "9", PAYMENT_ENABLED: "false" });
  // Drizzle configures its own client's JSON serializers. Keep fixture SQL on
  // an independent pool so sql.json retains postgres.js's normal object codec.
  rawPg = createPgClient(inject("DATABASE_URL"), { name: "mini-tool-consumption-fixtures", max: 4 });
});

/** The producer supplies policy once, before it can submit this frozen identity. */
interface OpenInput extends RecordInput {
  chargeTo: Consumption["chargeTo"];
  creditMultiplier: number;
  containerPricing: Consumption["containerPricing"];
}

/**
 * Invoke the producer entry without importing an implementation that does not exist yet.
 * @param input - The actual step identity and its first frozen charge policy.
 * @returns The pending or already recorded original consumption.
 * @throws {Error} When the production entry is absent or rejects the operation.
 */
async function openConsumption(input: OpenInput): Promise<Consumption> {
  const entry: unknown = Reflect.get(domain, "openMiniToolConsumption");
  expect(entry, "domain exports openMiniToolConsumption").toBeTypeOf("function");
  return (entry as (request: OpenInput) => Promise<Consumption>)(input);
}

/**
 * Invoke the explicit producer fence after computation can no longer submit work.
 * @param taskId - The terminal owning task.
 * @returns The durable settlement period.
 * @throws {Error} When the entry is absent or rejects an unsafe close.
 */
async function closeConsumptionSet(taskId: string): Promise<Settlement> {
  const entry: unknown = Reflect.get(domain, "completeMiniToolConsumptionSet");
  expect(entry, "domain exports completeMiniToolConsumptionSet").toBeTypeOf("function");
  return (entry as (id: string) => Promise<Settlement>)(taskId);
}

/**
 * Leave real task/step/node rows in their state immediately before first submission.
 * @returns The independent expected policy, key and database fixture.
 * @throws {Error} When fixture persistence fails.
 */
async function seedUnopened(): Promise<{ fixture: Fixture; input: OpenInput }> {
  const identity = { kind: "container", containerClass: "MediaContainer", jobId: `job:${crypto.randomUUID()}`, chunkIndex: 0 } as const;
  const fixture = await seed({ identity, state: "pending", parentStatus: "running" });
  await rawPg`UPDATE tasks SET result = result - 'settlement', completed_at = NULL WHERE id = ${fixture.taskId}`;
  await rawPg`
    UPDATE task_upstream_steps SET status = 'pending', endpoint = 'MediaContainer', output = output - 'miniToolConsumption'
    WHERE id = ${fixture.stepId}
  `;
  return { fixture, input: {
    taskId: fixture.taskId, stepId: fixture.stepId, identity,
    chargeTo: "user", creditMultiplier: 2, containerPricing: fixture.consumption.containerPricing,
  } };
}

interface OpenPlanInput {
  taskId: string;
  stepId: string;
  chunkIndex: number;
  chargeTo: "user" | "platform";
  request: Record<string, unknown>;
}
interface OpenPlanResult { request: Record<string, unknown>; consumption: Consumption }

/**
 * Construct a valid indexed request independently from the future persistence entry.
 * @param fixture - The original owning task and step.
 * @param storageKey - A newly issued candidate output key.
 * @returns The exact proposed first request.
 */
// A job frame recipe names a grid frame of the frozen grid, the tool source and its PNG target (frames-split §7.16).
function plannedRequest(fixture: Fixture, storageKey = "issued/frame-8.png"): Record<string, unknown> {
  const inputId = "20000000-0000-4000-8000-000000000001";
  return {
    schemaVersion: 2, jobId: `task:${fixture.taskId}:chunk:0`, containerClass: "MediaContainer",
    deadlineAt: 1792920000000,
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
    inputs: [{ inputId, storageKey: "frozen/source.mp4" }],
    outputs: [{ outputIndex: 8, storageKey, contentType: "image/png", recipe: { kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 42, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }],
  };
}

/**
 * Exercise the real transactional job opening through the public worker-facing entry.
 * @param input - An owned step and a candidate complete request.
 * @returns The first stored request and its paired consumption.
 * @throws {Error} When the entry is absent or rejects the operation.
 */
async function openPlan(input: OpenPlanInput): Promise<OpenPlanResult> {
  const entry: unknown = Reflect.get(domain, "openMiniToolPlanJob");
  expect(entry, "domain exports openMiniToolPlanJob").toBeTypeOf("function");
  return (entry as (request: OpenPlanInput) => Promise<OpenPlanResult>)(input);
}

describe("planned job and pending consumption share one durable opening", () => {
  it("freezes the complete request and its priced pending identity in the same task period", async () => {
    const { fixture } = await seedUnopened();
    const request = plannedRequest(fixture);
    const result = await openPlan({ taskId: fixture.taskId, stepId: fixture.stepId, chunkIndex: 0, chargeTo: "user", request });
    expect(result.request).toEqual(request);
    expect(result.consumption).toMatchObject({
      identity: { kind: "container", containerClass: "MediaContainer", jobId: request.jobId, chunkIndex: 0 },
      state: "pending", chargeTo: "user", creditMultiplier: 9, costUsd: null, credits: null,
      containerPricing: { size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 } },
    });
    const after = await snapshot(fixture);
    expect(after.step.output.miniToolPlanJob).toEqual(request);
    expect(after.step.output.miniToolConsumption).toEqual(result.consumption);
    expect(after.task.result.settlement.pendingConsumptionKeys).toEqual([result.consumption.consumptionKey]);
    expect(after.usage).toEqual([]);
    const [usageCount] = await rawPg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE actor_user_id = ${fixture.userId}`;
    expect(usageCount?.count).toBe(0);
    expect(after.task.result.manifest).toEqual(MANIFEST);
  });

  it("returns the first keys, deadline, limits and policy after a retry proposes newly allocated keys", async () => {
    const { fixture } = await seedUnopened();
    const input: OpenPlanInput = { taskId: fixture.taskId, stepId: fixture.stepId, chunkIndex: 0, chargeTo: "platform", request: plannedRequest(fixture) };
    const first = await openPlan(input);
    const before = await snapshot(fixture);
    expect(await openPlan({ ...input, chargeTo: "user", request: {
      ...plannedRequest(fixture, "unused/retry.png"), deadlineAt: 1792927200000,
      limits: { probeStdoutBytes: 100, analysisStdoutBytes: 100, stderrTailBytes: 100 },
    } })).toEqual(first);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("recovers its frozen job after parent failure without opening a new call", async () => {
    const { fixture } = await seedUnopened();
    const input: OpenPlanInput = { taskId: fixture.taskId, stepId: fixture.stepId, chunkIndex: 0, chargeTo: "user", request: plannedRequest(fixture) };
    const first = await openPlan(input);
    await rawPg`UPDATE tasks SET status = 'failed', completed_at = now() WHERE id = ${fixture.taskId}`;
    const before = await snapshot(fixture);
    expect(await openPlan(input)).toEqual(first);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it.each(["jobId", "chunkIndex"])("refuses replacement %s on the same stored step", async (field) => {
    const { fixture } = await seedUnopened();
    const input: OpenPlanInput = { taskId: fixture.taskId, stepId: fixture.stepId, chunkIndex: 0, chargeTo: "user", request: plannedRequest(fixture) };
    await openPlan(input);
    const before = await snapshot(fixture);
    await expect(openPlan(field === "jobId" ? { ...input, request: { ...input.request, jobId: "replacement" } } : { ...input, chunkIndex: 1 })).rejects.toThrow();
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("rolls back the request and pending consumption together when the parent period fails to write", async () => {
    const { fixture } = await seedUnopened();
    const before = await snapshot(fixture);
    const triggerName = `fail_plan_${crypto.randomUUID().replaceAll("-", "")}`;
    await rawPg.unsafe(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${fixture.taskId}'::uuid THEN RAISE EXCEPTION 'forced plan opening failure'; END IF;
      RETURN NEW; END $$`);
    await rawPg.unsafe(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
    try {
      await expect(openPlan({ taskId: fixture.taskId, stepId: fixture.stepId, chunkIndex: 0, chargeTo: "user", request: plannedRequest(fixture) }))
        .rejects.toMatchObject({ cause: { message: "forced plan opening failure" } });
      expect(await snapshot(fixture)).toEqual(before);
    } finally {
      await rawPg.unsafe(`DROP TRIGGER ${triggerName} ON tasks`);
      await rawPg.unsafe(`DROP FUNCTION ${triggerName}()`);
    }
  });

  it("serializes concurrent first proposals before choosing one persistent request", async () => {
    const { fixture } = await seedUnopened();
    const input: OpenPlanInput = { taskId: fixture.taskId, stepId: fixture.stepId, chunkIndex: 0, chargeTo: "user", request: plannedRequest(fixture) };
    const gate = await rawPg.reserve();
    const running: Promise<OpenPlanResult>[] = [];
    await gate`BEGIN`;
    try {
      await gate`SELECT id FROM tasks WHERE id = ${fixture.taskId} FOR UPDATE`;
      running.push(openPlan(input));
      void running[0]!.catch(() => undefined);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 1);
      running.push(openPlan({ ...input, request: plannedRequest(fixture, "unused/concurrent.png") }));
      void running[1]!.catch(() => undefined);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 2);
    } finally {
      await gate`ROLLBACK`;
      gate.release();
    }
    const [first, second] = await Promise.all(running);
    expect(first).toEqual(second);
    const after = await snapshot(fixture);
    expect(after.task.result.settlement).toMatchObject({ version: 1, pendingConsumptionKeys: [first!.consumption.consumptionKey] });
    expect(after.step.output.miniToolPlanJob).toEqual(first!.request);
  });
});

describe("mini-tool consumption producer persistence", () => {
  it("persists pending identity and a due period before any cost is known", async () => {
    const { fixture, input } = await seedUnopened();
    const before = await snapshot(fixture);
    const opened = await openConsumption(input);
    expect(opened).toEqual(fixture.consumption);
    const after = await snapshot(fixture);
    expect(after.step.output.miniToolConsumption).toEqual(opened);
    expect(after.task.result.settlement).toMatchObject({
      version: 1, state: "waiting", pendingConsumptionKeys: [opened.consumptionKey],
      consumptionSetComplete: false, leaseToken: null, leaseUntil: null,
    });
    expect(Date.parse(after.task.result.settlement.nextAttemptAt!)).toBeGreaterThan(0);
    expect(after.usage).toEqual([]);
    expect(after.task.params).toEqual(before.task.params);
    expect(after.task.result.manifest).toEqual(before.task.result.manifest);
    expect(after.step.output.preservedOutput).toEqual(before.step.output.preservedOutput);
    expect(after.task.status).toBe("running");
    expect(after.task.billed_at).toBeNull();
    expect(after.node).toEqual(before.node);
  });

  it("replays the first policy and price after deployment configuration changes", async () => {
    const { fixture, input } = await seedUnopened();
    const first = await openConsumption(input);
    const before = await snapshot(fixture);
    const replay = await openConsumption({ ...input, chargeTo: "platform", creditMultiplier: 9,
      containerPricing: { ...input.containerPricing!, configVersion: "changed", size: { vcpu: 4, memory_gib: 16, disk_gb: 32 } },
    });
    expect(replay).toEqual(first);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("rejects another upstream identity without replacing the original pending fact", async () => {
    const { fixture, input } = await seedUnopened();
    await openConsumption(input);
    const before = await snapshot(fixture);
    await expect(openConsumption({ ...input, identity: { ...input.identity, kind: "container", containerClass: "MediaContainer", jobId: "replacement", chunkIndex: 0 } })).rejects.toThrow();
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("requires the actual owning container step and refuses a foreign task step", async () => {
    const { fixture, input } = await seedUnopened();
    const other = await seedUnopened();
    await expect(openConsumption({ ...input, stepId: other.fixture.stepId })).rejects.toThrow();
    await rawPg`UPDATE task_upstream_steps SET kind = 'generate' WHERE id = ${fixture.stepId}`;
    await expect(openConsumption(input)).rejects.toThrow();
    expect((await snapshot(fixture)).step.output.miniToolConsumption).toBeUndefined();
  });

  // A model step's consumption is opened by its end (model-step.service.ts), never through the generic producer.
  it("refuses to open a model step's consumption", async () => {
    const fixture = await seed({ state: "pending", parentStatus: "running" });
    await rawPg`UPDATE tasks SET result = result - 'settlement', completed_at = NULL WHERE id = ${fixture.taskId}`;
    await rawPg`UPDATE task_upstream_steps SET output = output - 'miniToolConsumption' WHERE id = ${fixture.stepId}`;
    const before = await rawPg`SELECT output FROM task_upstream_steps WHERE id = ${fixture.stepId}`;
    await expect(openConsumption({ taskId: fixture.taskId, stepId: fixture.stepId, identity: fixture.identity, chargeTo: "user", creditMultiplier: 2, containerPricing: null })).rejects.toThrow();
    expect(await rawPg`SELECT output FROM task_upstream_steps WHERE id = ${fixture.stepId}`).toEqual(before);
  });

  it("keeps incomplete costs pending when a failed computation closes its call set", async () => {
    const { fixture, input } = await seedUnopened();
    await openConsumption(input);
    await expect(closeConsumptionSet(fixture.taskId)).rejects.toThrow();
    await rawPg`UPDATE tasks SET status = 'failed', completed_at = now() WHERE id = ${fixture.taskId}`;
    const closed = await closeConsumptionSet(fixture.taskId);
    expect(closed).toMatchObject({ consumptionSetComplete: true, state: "waiting", pendingConsumptionKeys: [fixture.consumption.consumptionKey] });
    const before = await snapshot(fixture);
    expect(await closeConsumptionSet(fixture.taskId)).toEqual(closed);
    expect(await openConsumption(input)).toEqual(fixture.consumption);
    expect(await snapshot(fixture)).toEqual(before);
    const settle: unknown = Reflect.get(domain, "settleMiniToolCharge");
    expect(await (settle as (id: string) => Promise<unknown>)(fixture.taskId)).toEqual({ state: "pending" });
    expect((await snapshot(fixture)).task.billed_at).toBeNull();
  });

  it("never creates a new consumption after computation has ended", async () => {
    const { fixture, input } = await seedUnopened();
    await rawPg`UPDATE tasks SET status = 'failed', completed_at = now() WHERE id = ${fixture.taskId}`;
    await closeConsumptionSet(fixture.taskId);
    const before = await snapshot(fixture);
    await expect(openConsumption(input)).rejects.toThrow();
    expect(await snapshot(fixture)).toEqual(before);
    expect(before.task.result.settlement.pendingConsumptionKeys).toEqual([]);
  });

  it("preserves a current lookup lease when computation ends with the same pending keys", async () => {
    const { fixture, input } = await seedUnopened();
    await openConsumption(input);
    const token = crypto.randomUUID();
    await rawPg`UPDATE tasks SET result = jsonb_set(result, '{settlement}', ${rawPg.json({
      version: 1, state: "checking", pendingConsumptionKeys: [fixture.consumption.consumptionKey],
      nextAttemptAt: T0, leaseToken: token, leaseUntil: "2099-01-01T00:00:00.000000Z",
      lastError: null, consumptionSetComplete: false,
    })}), status = 'failed', completed_at = now() WHERE id = ${fixture.taskId}`;
    const closed = await closeConsumptionSet(fixture.taskId);
    expect(closed).toMatchObject({
      version: 1, state: "checking", leaseToken: token, leaseUntil: "2099-01-01T00:00:00.000000Z",
      pendingConsumptionKeys: [fixture.consumption.consumptionKey], consumptionSetComplete: true,
    });
    expect((await snapshot(fixture)).usage).toEqual([]);
  });

  it("invalidates an old lookup lease when another actual identity joins the call set", async () => {
    const { fixture, input } = await seedUnopened();
    await openConsumption(input);
    await rawPg`UPDATE tasks SET result = jsonb_set(result, '{settlement}', ${rawPg.json({
      version: 1, state: "checking", pendingConsumptionKeys: [fixture.consumption.consumptionKey],
      nextAttemptAt: T0, leaseToken: "old-owner", leaseUntil: "2099-01-01T00:00:00.000000Z",
      lastError: null, consumptionSetComplete: false,
    })}) WHERE id = ${fixture.taskId}`;
    const stepId = crypto.randomUUID();
    const identity = { kind: "container", containerClass: "MediaContainer", jobId: "chunk-1", chunkIndex: 1 } as const;
    await rawPg`INSERT INTO task_upstream_steps (id, task_id, position, kind, endpoint, status, output)
      VALUES (${stepId}, ${fixture.taskId}, 1, 'container_job', 'MediaContainer', 'pending', '{}'::jsonb)`;
    const second = await openConsumption({ ...input, stepId, identity });
    const after = await snapshot(fixture);
    expect(after.task.result.settlement).toMatchObject({
      version: 2, state: "waiting", leaseToken: null, leaseUntil: null, consumptionSetComplete: false,
      pendingConsumptionKeys: [fixture.consumption.consumptionKey, second.consumptionKey],
    });
  });

  it.each(["pending", "running"])("opens platform-funded work without inventing a known zero on a %s parent", async (status) => {
    const { fixture, input } = await seedUnopened();
    await rawPg`UPDATE tasks SET status = ${status} WHERE id = ${fixture.taskId}`;
    const fact = await openConsumption({ ...input, chargeTo: "platform" });
    expect(fact).toMatchObject({ state: "pending", chargeTo: "platform", creditMultiplier: 2, costUsd: null, credits: null });
    expect((await snapshot(fixture)).usage).toEqual([]);
  });

  it("replays an already recorded identity after parent completion without rewriting a period", async () => {
    const fixture = await seed({ state: "recorded", parentStatus: "completed" });
    const before = await snapshot(fixture);
    expect(await openConsumption({ taskId: fixture.taskId, stepId: fixture.stepId, identity: fixture.identity,
      chargeTo: "platform", creditMultiplier: 9, containerPricing: fixture.consumption.containerPricing })).toEqual(fixture.consumption);
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("closes an explicitly empty terminal set and permits the existing zero settlement", async () => {
    const { fixture } = await seedUnopened();
    await rawPg`UPDATE tasks SET status = 'completed', completed_at = now() WHERE id = ${fixture.taskId}`;
    expect(await closeConsumptionSet(fixture.taskId)).toMatchObject({ consumptionSetComplete: true, pendingConsumptionKeys: [] });
    const settle: unknown = Reflect.get(domain, "settleMiniToolCharge");
    expect(await (settle as (id: string) => Promise<unknown>)(fixture.taskId)).toMatchObject({ state: "settled", credits: 0, first: true });
    const after = await snapshot(fixture);
    expect(after.task.billed_at).not.toBeNull();
    expect(Number(after.task.billed_credits)).toBe(0);
    expect(after.usage).toEqual([]);
  });

  it.each(["wrong-source", "wrong-class", "missing-price", "closed-set", "already-billed", "corrupt-period"])("refuses unsafe opening %s without a partial consumption write", async (scenario) => {
    const { fixture, input } = await seedUnopened();
    if (scenario === "wrong-source") await rawPg`UPDATE tasks SET source = 'user' WHERE id = ${fixture.taskId}`;
    if (scenario === "wrong-class") await rawPg`UPDATE task_upstream_steps SET endpoint = 'AnotherContainer' WHERE id = ${fixture.stepId}`;
    if (scenario === "closed-set" || scenario === "corrupt-period") {
      const period = scenario === "closed-set" ? { ...fixture.settlement, consumptionSetComplete: true } : { version: "bad" };
      await rawPg`UPDATE tasks SET result = jsonb_set(result, '{settlement}', ${rawPg.json(period)}) WHERE id = ${fixture.taskId}`;
    }
    if (scenario === "already-billed") await rawPg`UPDATE tasks SET billed_at = now(), billed_credits = 0 WHERE id = ${fixture.taskId}`;
    const before = await snapshot(fixture);
    await expect(openConsumption(scenario === "missing-price" ? { ...input, containerPricing: null } : input)).rejects.toThrow();
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("preserves generated first policies across repeat admissions", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 20 }), async (platform, multiplier) => {
      const { fixture, input } = await seedUnopened();
      const first = await openConsumption({ ...input, chargeTo: platform ? "platform" : "user", creditMultiplier: multiplier });
      expect(first).toMatchObject({ state: "pending", chargeTo: platform ? "platform" : "user", creditMultiplier: multiplier, costUsd: null });
      expect(await openConsumption({ ...input, creditMultiplier: multiplier + 1 })).toEqual(first);
      expect((await snapshot(fixture)).task.result.settlement.pendingConsumptionKeys).toEqual([first.consumptionKey]);
    }), { numRuns: 8 });
  });

  it("serializes first writers on the immutable task row before reading the step", async () => {
    const { fixture, input } = await seedUnopened();
    const gate = await rawPg.reserve();
    const running: Promise<Consumption>[] = [];
    await gate`BEGIN`;
    try {
      await gate`SELECT id FROM tasks WHERE id = ${fixture.taskId} FOR UPDATE`;
      running.push(openConsumption(input));
      void running[0]!.catch(() => undefined);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 1);
      running.push(openConsumption(input));
      void running[1]!.catch(() => undefined);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 2);
    } finally {
      await gate`ROLLBACK`;
      gate.release();
    }
    const [first, second] = await Promise.all(running);
    expect(first).toEqual(second);
    const after = await snapshot(fixture);
    expect(after.task.result.settlement).toMatchObject({ version: 1, pendingConsumptionKeys: [fixture.consumption.consumptionKey] });
    expect(after.usage).toEqual([]);
  });

  it("rolls back the new step fact if the settlement write fails", async () => {
    const { fixture, input } = await seedUnopened();
    const before = await snapshot(fixture);
    const triggerName = `fail_open_${crypto.randomUUID().replaceAll("-", "")}`;
    await rawPg.unsafe(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${fixture.taskId}'::uuid THEN RAISE EXCEPTION 'forced opening settlement failure'; END IF;
      RETURN NEW; END $$`);
    await rawPg.unsafe(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
    try {
      await expect(openConsumption(input)).rejects.toThrow();
      expect(await snapshot(fixture)).toEqual(before);
    } finally {
      await rawPg.unsafe(`DROP TRIGGER ${triggerName} ON tasks`);
      await rawPg.unsafe(`DROP FUNCTION ${triggerName}()`);
    }
    await openConsumption(input);
    expect((await snapshot(fixture)).step.output.miniToolConsumption).toEqual(fixture.consumption);
  });
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
  const identity = options.identity ?? { kind: "container", containerClass: "MiniToolContainerStd1", jobId: `job-${stepId}`, chunkIndex: 0 };
  const state = options.state ?? "known";
  const costUsd = state === "pending" ? null : options.costUsd ?? (options.chargeTo === "platform" ? 0.00001256 : 0.000055);
  const consumption: Consumption = {
    schemaVersion: 1, consumptionKey: await miniToolConsumptionKey({ taskId, stepId, identity }), identity,
    state, creditMultiplier: options.creditMultiplier ?? 2, chargeTo: options.chargeTo ?? "user",
    costUsd, costSource: state === "pending" ? null : "computed",
    raw: costUsd === null ? null : { wallMs: 1000, cpuUsec: 100000 },
    credits: state === "recorded" ? (options.chargeTo === "platform" ? 0 : costUsd! * 100 * (options.creditMultiplier ?? 2)) : null,
    containerPricing: {
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
    INSERT INTO task_upstream_steps (id, task_id, position, kind, endpoint, status, output)
    VALUES (${stepId}, ${taskId}, 0, 'container_job', 'scene_cuts', 'done',
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

  it("records the fixed container identity once without changing its failed parent or deadline", async () => {
    const fixture = await seed({ taskId: FIXED_TASK, stepId: FIXED_STEP, identity: FIXED_IDENTITY });
    expect(fixture.consumption.consumptionKey).toBe(FIXED_KEY);
    const before = await snapshot(fixture);
    const result = await record(fixture);
    const after = await snapshot(fixture);
    expect(result).toEqual(after.step.output.miniToolConsumption);
    expect(after.step.output.miniToolConsumption).toEqual({ ...fixture.consumption, state: "recorded", credits: expect.closeTo(0.011, 12) });
    expect(after.usage).toHaveLength(1);
    expect(after.usage[0]).toMatchObject({ operation_key: FIXED_KEY, feature: "mini_tool", source: "container", provider: "cloudflare", cost_source: "computed" });
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
      identity: { kind: "container", containerClass: "MiniToolContainerStd1", jobId: "split-preparation-001", chunkIndex: 0 },
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
    await expect(record({ ...fixture, identity: { ...fixture.identity, jobId: crypto.randomUUID() } })).rejects.toThrow();
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
      identity: fault === "identity" ? { ...fixture.identity, jobId: crypto.randomUUID() } : fixture.identity,
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
    const identity = { ...fixture.identity, jobId: `job-${secondStep}` };
    const key = await miniToolConsumptionKey({ taskId: fixture.taskId, stepId: secondStep, identity });
    const second = { ...fixture.consumption, consumptionKey: key, identity };
    await rawPg`
      INSERT INTO task_upstream_steps (id, task_id, position, kind, endpoint, status, output)
      VALUES (${secondStep}, ${fixture.taskId}, 1, 'container_job', 'scene_cuts', 'done',
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
      requestCount: 1, costUsd: 0.000055, costSource: "provider", costIdentity: null, credits: 0.011,
    };
    await insertUsageRecord(row);
    await insertUsageRecord(row);
    const [counts] = await rawPg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key = ${operationKey}`;
    expect(counts?.count).toBe(2);
  });
});
