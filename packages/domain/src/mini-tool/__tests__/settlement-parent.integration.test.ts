// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import crypto from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import { miniToolConsumptionKey, type MiniToolConsumptionIdentity } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import { settleCharge } from "@domain/credit/creditLot.service.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

// Only notification delivery is replaced; DB, transaction and credit engine stay real.
const { notify } = vi.hoisted(() => ({ notify: vi.fn<(projectId: string) => Promise<void>>() }));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...await importOriginal<typeof core>(),
  publishCreditsChanged: notify,
}));

interface Consumption {
  schemaVersion: 1;
  consumptionKey: string;
  identity: MiniToolConsumptionIdentity;
  state: "pending" | "known" | "recorded";
  creditMultiplier: number;
  chargeTo: "user" | "platform";
  costUsd: number | null;
  costSource: "generation_lookup" | "computed" | null;
  raw: { deductUsd: number; refundUsd: number } | { wallMs: number; cpuUsec: number } | null;
  credits: number | null;
  containerPricing: {
    configVersion: string;
    size: { vcpu: number; memory_gib: number; disk_gb: number };
    prices: { vcpu_second_usd: number; memory_gib_second_usd: number; disk_gb_second_usd: number };
  } | null;
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

interface Fixture {
  taskId: string;
  userId: string;
  studioId: string;
  projectId: string;
  nodeTaskId: string;
  lotId: string;
  keys: string[];
}

interface SeedOptions {
  status?: "pending" | "running" | "completed" | "failed";
  complete?: boolean;
  states?: Consumption["state"][];
  rawCredits?: number[];
  platform?: boolean;
  balance?: number;
  hold?: number;
  missingProject?: boolean;
}

interface Snapshot {
  task: {
    status: string;
    billed_at: string | null;
    billed_credits: number | null;
    credits_used: number;
    completed_at: string | null;
    created_at: string;
    params: unknown;
    result: { manifest: unknown; preserved: unknown; settlement: Settlement };
  };
  steps: { id: string; status: string; prediction_id: string | null; output: unknown }[];
  node: { status: string; started_at: string; settled_at: string | null; budget_ms: number; updated_at: string };
  lot: { remaining: string; lifecycle: string };
  debt: string;
  hold: { status: string; amount: string; released_at: string | null; updated_at: string };
  ledger: { id: string; entry_type: string; amount: string; lot_id: string | null; studio_id: string | null; reference_id: string }[];
  usage: { operation_key: string; cost_usd: string; credits: string }[];
}

type FailurePoint = "ledger" | "hold" | "settled" | "standalone_hold";

const T0 = "2026-10-24T09:03:03.100001Z";
const DEADLINE = "2026-10-24T11:03:03.100001Z";
const MANIFEST = { resultVersion: 3, outputs: [{ outputIndex: 0, registeredUrl: "https://assets.test.invalid/kept.mp4" }, { outputIndex: 1, error: "persist_failed", status: "failed" }] };
let rawPg: ReturnType<typeof core.createPgClient>;

/**
 * Configure the real engine while deliberately changing the deployment multiplier.
 * @returns Nothing.
 * @throws {Error} When test configuration is invalid.
 */
function payments(enabled: boolean): void {
  core.initCore({
    ...process.env,
    PAYMENT_ENABLED: enabled ? "true" : "false",
    CREDIT_MULTIPLIER: "9",
    STRIPE_SECRET_KEY: "sk_test_unused_by_parent_settlement",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_parent_settlement",
  });
}

beforeAll(() => {
  payments(true);
  core.loadLocales();
  // Keep postgres.js JSON codecs independent from Drizzle's configured pool.
  rawPg = core.createPgClient(inject("DATABASE_URL"), { name: "mini-tool-parent-fixtures", max: 6 });
  notify.mockResolvedValue(undefined);
});

beforeEach(() => {
  payments(true);
  vi.mocked(core.publishCreditsChanged).mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rawPg.end();
});

/**
 * Reach the future production entry through the existing public domain barrel.
 * @returns The callable parent settlement entry.
 * @throws {Error} When the approved entry is missing.
 */
function entry(): (taskId: string) => Promise<unknown> {
  const value: unknown = Reflect.get(domain, "settleMiniToolCharge");
  expect(value, "domain exports settleMiniToolCharge").toBeTypeOf("function");
  return value as (taskId: string) => Promise<unknown>;
}

/**
 * Insert valid financial fixtures and a complete recorded consumption snapshot.
 * @returns The immutable identities used by later SQL assertions.
 * @throws {Error} When fixture SQL or canonical identity generation fails.
 */
async function seed(options: SeedOptions = {}): Promise<Fixture> {
  const taskId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const nodeTaskId = crypto.randomUUID();
  const lotId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const spaceId = crypto.randomUUID();
  const status = options.status ?? "failed";
  const terminal = status === "completed" || status === "failed";
  const values = options.rawCredits ?? [0.011, 0.011];
  const states = options.states ?? values.map(() => "recorded" as const);
  if (states.length !== values.length) throw new Error("Fixture states and costs differ in length");
  const facts: { stepId: string; consumption: Consumption }[] = [];
  for (const [position, credits] of values.entries()) {
    const stepId = crypto.randomUUID();
    const identity: MiniToolConsumptionIdentity = options.platform
      ? { kind: "container", containerClass: "MiniToolContainerStd1", jobId: `presentation-${taskId}-${position}`, chunkIndex: position }
      : { kind: "provider", stepId };
    const state = states[position]!;
    const costUsd = state === "pending" ? null : options.platform ? 0.00001256 : credits / 200;
    facts.push({ stepId, consumption: {
      schemaVersion: 1, consumptionKey: await miniToolConsumptionKey({ taskId, stepId, identity }), identity,
      state, creditMultiplier: 2, chargeTo: options.platform ? "platform" : "user",
      costUsd, costSource: state === "pending" || identity.kind === "provider" ? null : "computed",
      raw: costUsd === null || identity.kind === "provider" ? null : { wallMs: 1000, cpuUsec: 100000 },
      credits: state === "recorded" ? options.platform ? 0 : credits : null,
      containerPricing: identity.kind === "provider" ? null : {
        configVersion: "cloudflare-2026-10-07",
        size: { vcpu: 0.5, memory_gib: 4, disk_gb: 8 },
        prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
      },
      // A model step's cost wait (inner#1306 §11.4): its one billed answer, known or still pending.
      ...(identity.kind === "provider" ? {
        servedBy: "wavespeed", attempts: 0, windowEndsAt: 4070908800000, nextLookupAt: state === "pending" ? 0 : null, known: costUsd ?? 0,
        costs: costUsd === null ? [] : [{ state: "known" as const, usd: costUsd, source: "billing" as const }],
        waiting: costUsd === null ? [{ lookup: { upstream: "wavespeed", predictionId: `parent-${taskId}-${position}` } }] : [],
      } : {}),
    } });
  }
  const manifest = status === "completed"
    ? { ...MANIFEST, outputs: [{ outputIndex: 0, registeredUrl: "https://assets.test.invalid/kept.mp4" }, { outputIndex: 1, registeredUrl: "https://assets.test.invalid/also-kept.mp4" }] }
    : MANIFEST;
  const complete = "complete" in options ? options.complete : true;
  const settlement: Settlement = {
    version: 7, state: terminal ? "waiting" : "idle",
    pendingConsumptionKeys: facts.filter(({ consumption }) => consumption.state !== "recorded").map(({ consumption }) => consumption.consumptionKey),
    nextAttemptAt: terminal ? T0 : null, leaseToken: null, leaseUntil: null, lastError: null,
    ...(complete === undefined ? {} : { consumptionSetComplete: complete }),
  };
  await rawPg`INSERT INTO users (id, email, email_verified) VALUES (${userId}, ${`parent-${userId}@example.test`}, true)`;
  // A two-character prefix plus UUID is 38 characters, below the studio limit.
  await rawPg`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${userId}, ${`p-${studioId}`}, 'team', 'Parent settlement')`;
  await rawPg`INSERT INTO projects (id, studio_id, created_by_user_id, slug, name) VALUES (${projectId}, ${studioId}, ${userId}, ${`p-${projectId}`}, 'Parent settlement')`;
  await rawPg`INSERT INTO credit_sources (id, kind) VALUES (${sourceId}, 'payment')`;
  await rawPg`INSERT INTO payments (id, user_id, amount_cents, status, credits_granted) VALUES (${sourceId}, ${userId}, 1000, 'completed', ${options.balance ?? 1})`;
  await rawPg`
    INSERT INTO credit_lots (id, source_id, source_kind, user_id, purchased_credits, remaining_credits, designated_studio_id, lifecycle)
    VALUES (${lotId}, ${sourceId}, 'payment', ${userId}, ${String(options.balance ?? 1)}, ${String(options.balance ?? 1)}, ${studioId}, 'active')
  `;
  await rawPg`
    INSERT INTO credit_ledger (payer_user_id, actor_user_id, lot_id, entry_type, amount, reference_id)
    VALUES (${userId}, ${userId}, ${lotId}, 'topup', ${String(options.balance ?? 1)}, ${`fixture-${sourceId}`})
  `;
  await rawPg`INSERT INTO studio_credit_debts (studio_id, amount) VALUES (${studioId}, 0)`;
  await rawPg`
    INSERT INTO tasks (id, user_id, project_id, space_id, task_type, mode, source, status, model, params, result, completed_at)
    VALUES (${taskId}, ${userId}, ${options.missingProject ? null : projectId}, ${spaceId}, 'mini_tool_analysis', 'append', 'mini_tool', ${status},
      'wavespeed-ai/sam3-video-rle', ${rawPg.json({ immutablePlan: "kept", deadlineAt: DEADLINE })},
      ${rawPg.json({ manifest, preserved: { original: true }, settlement: { ...settlement } })}, ${terminal ? T0 : null}::text::timestamptz)
  `;
  await rawPg`
    INSERT INTO node_tasks (id, project_id, space_id, node_id, kind, action, status, started_by_user_id, started_at, settled_at, budget_ms, label, task_id)
    VALUES (${nodeTaskId}, ${projectId}, ${spaceId}, ${crypto.randomUUID()}, 'generation', 'mini_tool', ${terminal ? 'failed' : 'running'}, ${userId},
      ${T0}::text::timestamptz, ${terminal ? T0 : null}::text::timestamptz, ${core.getNodeTaskConfig().default_budget_ms}, 'analysis', ${taskId})
  `;
  await rawPg`
    INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, status, expires_at)
    VALUES (${studioId}, ${userId}, ${taskId}, ${String(options.hold ?? 0.1)}, 'held', '2099-01-01T00:00:00Z')
  `;
  for (const [position, { stepId, consumption }] of facts.entries()) {
    await rawPg`
      INSERT INTO task_upstream_steps (id, task_id, position, kind, endpoint, status, prediction_id, output)
      VALUES (${stepId}, ${taskId}, ${position}, ${consumption.identity.kind === "provider" ? "generate" : "container_job"},
        ${consumption.identity.kind === "provider" ? "wavespeed-ai/sam3-video-rle" : "presentation_prepare"}, 'done',
        ${null},
        ${rawPg.json({ preservedOutput: { original: true }, miniToolConsumption: { ...consumption } })})
    `;
    if (consumption.state === "recorded") {
      await rawPg`
        INSERT INTO agent_usage_records (operation_key, feature, source, actor_user_id, project_id, model, provider, request_count, cost_usd, cost_source, credits)
        VALUES (${consumption.consumptionKey}, 'mini_tool', ${consumption.identity.kind === "provider" ? "model" : "container"},
          ${userId}, ${options.missingProject ? null : projectId},
          ${consumption.identity.kind === "provider" ? "wavespeed-ai/sam3-video-rle" : "cloudflare-container:presentation_prepare"},
          ${consumption.identity.kind === "provider" ? "wavespeed" : "cloudflare"}, 1,
          ${String(consumption.costUsd)}, ${consumption.costSource ?? "generation_lookup"}, ${String(consumption.credits)})
      `;
    }
  }
  return { taskId, userId, studioId, projectId, nodeTaskId, lotId, keys: facts.map(({ consumption }) => consumption.consumptionKey) };
}

/**
 * Read financial, consumption and original media facts through the independent pool.
 * @returns A persisted snapshot with all absolute instants kept as SQL text.
 * @throws {Error} When a fixture row is missing or SQL fails.
 */
async function snapshot(fixture: Fixture): Promise<Snapshot> {
  const [task] = await rawPg<Snapshot["task"][]>`
    SELECT status, billed_at::text, billed_credits, credits_used, completed_at::text, created_at::text, params, result FROM tasks WHERE id = ${fixture.taskId}
  `;
  const steps = await rawPg<Snapshot["steps"]>`SELECT id, status, prediction_id, output FROM task_upstream_steps WHERE task_id = ${fixture.taskId} ORDER BY position`;
  const [node] = await rawPg<Snapshot["node"][]>`SELECT status, started_at::text, settled_at::text, budget_ms, updated_at::text FROM node_tasks WHERE id = ${fixture.nodeTaskId}`;
  const [lot] = await rawPg<Snapshot["lot"][]>`SELECT remaining_credits::text AS remaining, lifecycle FROM credit_lots WHERE id = ${fixture.lotId}`;
  const [debt] = await rawPg<{ amount: string }[]>`SELECT amount::text FROM studio_credit_debts WHERE studio_id = ${fixture.studioId}`;
  const [hold] = await rawPg<Snapshot["hold"][]>`SELECT status, amount::text, released_at::text, updated_at::text FROM credit_holds WHERE reference_id = ${fixture.taskId}`;
  const ledger = await rawPg<Snapshot["ledger"]>`SELECT id, entry_type, amount::text, lot_id, studio_id, reference_id FROM credit_ledger WHERE reference_id = ${fixture.taskId} ORDER BY id`;
  const usage = await rawPg<Snapshot["usage"]>`SELECT operation_key, cost_usd::text, credits::text FROM agent_usage_records WHERE actor_user_id = ${fixture.userId} AND feature = 'mini_tool' ORDER BY operation_key`;
  if (!task || !node || !lot || !debt || !hold) throw new Error("Parent settlement fixture is incomplete");
  return { task, steps, node, lot, debt: debt.amount, hold, ledger, usage };
}

/**
 * Assert the original computation, media manifest, deadline and consumption remain intact.
 * @returns Nothing.
 * @throws {Error} When an independent invariant fails.
 */
function preserved(before: Snapshot, after: Snapshot): void {
  expect(after.task.status).toBe(before.task.status);
  expect(after.task.completed_at).toBe(before.task.completed_at);
  expect(after.task.created_at).toBe(before.task.created_at);
  expect(after.task.params).toEqual(before.task.params);
  expect(after.task.result.manifest).toEqual(before.task.result.manifest);
  expect(after.task.result.preserved).toEqual(before.task.result.preserved);
  expect(after.task.result.settlement.consumptionSetComplete).toBe(before.task.result.settlement.consumptionSetComplete);
  expect(after.steps).toEqual(before.steps);
  expect(after.node).toEqual(before.node);
  expect(after.usage).toEqual(before.usage);
}

/**
 * Assert that an ineligible run or failed transaction moved no funds or guard.
 * @returns Nothing.
 * @throws {Error} When a persisted financial invariant fails.
 */
function unclaimed(before: Snapshot, after: Snapshot): void {
  preserved(before, after);
  expect(after.task.billed_at).toBeNull();
  expect(after.task.billed_credits).toBeNull();
  expect(after.task.credits_used).toBe(before.task.credits_used);
  expect(after.lot).toEqual(before.lot);
  expect(after.debt).toBe(before.debt);
  expect(after.hold).toEqual(before.hold);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.task.result.settlement.state).not.toBe("settled");
}

/**
 * Assert one fixed parent claim and released hold independently of notification success.
 * @returns Nothing.
 * @throws {Error} When persisted settlement facts disagree.
 */
function claimed(before: Snapshot, after: Snapshot, credits: number): void {
  preserved(before, after);
  expect(after.task.billed_credits).toBe(credits);
  expect(after.task.credits_used).toBe(credits);
  expect(after.task.billed_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2} /));
  expect(after.hold.status).toBe("released");
  expect(after.hold.released_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2} /));
  expect(after.task.result.settlement).toMatchObject({ state: "settled", pendingConsumptionKeys: [] });
}

/**
 * Assert a parent whose claim and charge request committed while the charge itself did not settle: billed, settled,
 * and funds, hold and ledger as they were.
 * @returns Nothing.
 */
function pendingCharge(before: Snapshot, after: Snapshot, credits: number): void {
  preserved(before, after);
  expect(after.task.billed_credits).toBe(credits);
  expect(after.task.result.settlement).toMatchObject({ state: "settled" });
  expect(after.lot).toEqual(before.lot);
  expect(after.hold).toEqual(before.hold);
  expect(after.ledger).toEqual(before.ledger);
}

/**
 * The parent's charge request still waiting to settle.
 * @returns Its id.
 * @throws {Error} When none is pending.
 */
async function pendingRequest(taskId: string): Promise<string> {
  const [row] = await rawPg<{ id: string }[]>`SELECT id FROM credit_charge_requests WHERE reference_id=${taskId} AND settled_at IS NULL`;
  if (!row) throw new Error("No pending charge request for the parent");
  return row.id;
}

/**
 * Install a real SQL fault after the guard, an engine mutation or final funds writes.
 * @returns Cleanup that removes only this fixture's temporary fault.
 * @throws {Error} When trigger creation or cleanup fails.
 */
async function installFault(fixture: Fixture, point: FailurePoint): Promise<() => Promise<void>> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const functionName = `parent_failure_${suffix}`;
  const triggerName = `parent_trigger_${suffix}`;
  const table = point === "ledger" ? "credit_ledger" : point === "settled" ? "tasks" : "credit_holds";
  const event = point === "ledger" ? "INSERT" : "UPDATE";
  const matches = point === "ledger" ? `NEW.reference_id = '${fixture.taskId}'` : point === "settled"
    ? `NEW.id = '${fixture.taskId}'::uuid AND NEW.result->'settlement'->>'state' = 'settled'`
    : `NEW.reference_id = '${fixture.taskId}' AND NEW.status = 'released'`;
  const guardCheck = point === "settled" ? "NEW.billed_at IS NOT NULL" : `EXISTS (SELECT 1 FROM tasks WHERE id = '${fixture.taskId}'::uuid AND billed_at IS NOT NULL)`;
  const committedWorkCheck = point === "ledger"
    ? `EXISTS (SELECT 1 FROM credit_lots WHERE id = '${fixture.lotId}'::uuid AND remaining_credits < 1)`
    : point === "settled"
      ? "true"
      : point === "standalone_hold" ? `EXISTS (SELECT 1 FROM credit_ledger WHERE reference_id = '${fixture.taskId}' AND lot_id IS NULL)` : "true";
  await rawPg.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ${matches} THEN
        IF NOT (${guardCheck}) THEN RAISE EXCEPTION 'parent guard was not written before engine mutation'; END IF;
        IF NOT (${committedWorkCheck}) THEN RAISE EXCEPTION 'parent fault did not follow the required real engine write'; END IF;
        RAISE EXCEPTION 'forced parent ${point} failure';
      END IF;
      RETURN NEW;
    END $$`);
  await rawPg.unsafe(`CREATE TRIGGER ${triggerName} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  return async () => {
    await rawPg.unsafe(`DROP TRIGGER ${triggerName} ON ${table}`);
    await rawPg.unsafe(`DROP FUNCTION ${functionName}()`);
  };
}

describe("mini-tool parent charge transaction", () => {
  it("exports the parent entry before testing financial state", () => {
    expect(Reflect.get(domain, "settleMiniToolCharge")).toBeTypeOf("function");
  });

  it.each(["completed", "failed"] as const)("charges the %s parent's two raw costs once after aggregate rounding", async (status) => {
    const settle = entry();
    const fixture = await seed({ status });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    const after = await snapshot(fixture);
    claimed(before, after, 0.03);
    expect(Number(after.lot.remaining)).toBe(0.97);
    expect(Number(after.debt)).toBe(0);
    expect(after.ledger).toHaveLength(1);
    expect(after.ledger[0]).toMatchObject({ entry_type: "spend", lot_id: fixture.lotId, reference_id: fixture.taskId });
    expect(Number(after.ledger[0]!.amount)).toBe(-0.03);
  });

  it.each(["pending", "running"] as const)("does not claim a %s parent with an already complete recorded set", async (status) => {
    const settle = entry();
    const fixture = await seed({ status });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    unclaimed(before, await snapshot(fixture));
    expect(core.publishCreditsChanged).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("does not infer completeness from an empty todo when the complete flag is %s", async (complete) => {
    const settle = entry();
    const fixture = await seed({ complete });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    unclaimed(before, await snapshot(fixture));
  });

  it.each(["pending", "known"] as const)("does not claim a terminal parent while one consumption is %s", async (state) => {
    const settle = entry();
    const fixture = await seed({ states: ["recorded", state] });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    unclaimed(before, await snapshot(fixture));
  });

  it("does not release a hold for an empty set that has not been closed", async () => {
    const settle = entry();
    const fixture = await seed({ rawCredits: [], complete: false });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    unclaimed(before, await snapshot(fixture));
  });

  it("confirms a complete empty set as zero without creating usage or financial rows", async () => {
    const settle = entry();
    const fixture = await seed({ rawCredits: [] });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    const after = await snapshot(fixture);
    claimed(before, after, 0);
    expect(after.lot).toEqual(before.lot);
    expect(after.debt).toBe(before.debt);
    expect(after.ledger).toEqual([]);
    expect(after.usage).toEqual([]);
  });

  it.each([false, true])("settles recorded zero user credits with platform funding %s", async (platform) => {
    const settle = entry();
    const fixture = await seed({ rawCredits: platform ? [0.011] : [0], platform });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    const after = await snapshot(fixture);
    claimed(before, after, 0);
    expect(after.lot).toEqual(before.lot);
    expect(after.debt).toBe(before.debt);
    expect(after.ledger).toEqual([]);
    expect(after.usage).toHaveLength(1);
    expect(Number(after.usage[0]!.credits)).toBe(0);
    expect(Number(after.usage[0]!.cost_usd)).toBe(platform ? 0.00001256 : 0);
  });

  it("queues two claims on the immutable task lock and posts only one charge", async () => {
    const settle = entry();
    const fixture = await seed();
    const before = await snapshot(fixture);
    const gate = await rawPg.reserve();
    const calls: Promise<unknown>[] = [];
    await gate`BEGIN`;
    try {
      await gate`SELECT id FROM tasks WHERE id = ${fixture.taskId} FOR UPDATE`;
      const first = settle(fixture.taskId);
      void first.catch(() => undefined);
      calls.push(first);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 1);
      const second = settle(fixture.taskId);
      void second.catch(() => undefined);
      calls.push(second);
      await waitUntilBlockedOn(rawPg, ["tasks", "for update"], 2);
    } finally {
      await gate`ROLLBACK`;
      gate.release();
      await Promise.allSettled(calls);
    }
    await Promise.all(calls);
    const after = await snapshot(fixture);
    claimed(before, after, 0.03);
    expect(Number(after.lot.remaining)).toBe(0.97);
    expect(after.ledger).toHaveLength(1);
    expect(Number(after.ledger[0]!.amount)).toBe(-0.03);
  });

  it("replays the fixed billed amount without posting another ledger entry", async () => {
    const settle = entry();
    const fixture = await seed();
    await settle(fixture.taskId);
    const once = await snapshot(fixture);
    await settle(fixture.taskId);
    await settle(fixture.taskId);
    expect(await snapshot(fixture)).toEqual(once);
  });

  // The parent claim and its charge request commit together; the charge settles after that commit, and a charge that
  // fails to settle stays pending for credit-charge-sweep, whose retry applies it once (domain AGENTS.md, charging).
  it.each(["ledger", "hold"] as const)("keeps the claimed charge pending when its %s write fails, and its retry applies it once", async (point) => {
    const settle = entry();
    const fixture = await seed();
    const before = await snapshot(fixture);
    const cleanup = await installFault(fixture, point);
    try {
      expect(await settle(fixture.taskId)).toMatchObject({ state: "settled", first: true, chargeFailure: expect.anything() });
      pendingCharge(before, await snapshot(fixture), 0.03);
      expect(core.publishCreditsChanged).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
    await settleCharge(await pendingRequest(fixture.taskId));
    const after = await snapshot(fixture);
    claimed(before, after, 0.03);
    expect(Number(after.lot.remaining)).toBe(0.97);
    expect(after.ledger).toHaveLength(1);
  });

  it("rolls back the parent claim and its charge request together when the settled state cannot be written, and succeeds on retry", async () => {
    const settle = entry();
    const fixture = await seed();
    const before = await snapshot(fixture);
    const cleanup = await installFault(fixture, "settled");
    try {
      await expect(settle(fixture.taskId)).rejects.toMatchObject({ cause: { message: "forced parent settled failure" } });
      unclaimed(before, await snapshot(fixture));
      expect(await rawPg`SELECT id FROM credit_charge_requests WHERE reference_id=${fixture.taskId}`).toHaveLength(0);
    } finally {
      await cleanup();
    }
    await settle(fixture.taskId);
    const after = await snapshot(fixture);
    claimed(before, after, 0.03);
    expect(after.ledger).toHaveLength(1);
  });

  it("posts the uncovered part as debt in the same fixed parent amount", async () => {
    const settle = entry();
    const fixture = await seed({ balance: 0.01, hold: 0.01 });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    const after = await snapshot(fixture);
    claimed(before, after, 0.03);
    expect(Number(after.lot.remaining)).toBe(0);
    expect(Number(after.debt)).toBe(0.02);
    expect(after.ledger).toHaveLength(2);
    expect(after.ledger.map((row) => [row.entry_type, Number(row.amount)]).sort()).toEqual([["debt_incurred", -0.02], ["spend", -0.01]]);
  });

  it.each(["payment_off", "missing_project"] as const)("commits standalone usage, guard and hold release for %s", async (mode) => {
    const settle = entry();
    if (mode === "payment_off") payments(false);
    const fixture = await seed({ missingProject: mode === "missing_project" });
    const before = await snapshot(fixture);
    await settle(fixture.taskId);
    const after = await snapshot(fixture);
    claimed(before, after, 0.03);
    expect(after.lot).toEqual(before.lot);
    expect(after.debt).toBe(before.debt);
    expect(after.ledger).toHaveLength(1);
    expect(after.ledger[0]).toMatchObject({ entry_type: "spend", lot_id: null, reference_id: fixture.taskId });
    expect(Number(after.ledger[0]!.amount)).toBe(-0.03);
    if (mode === "missing_project") expect(after.ledger[0]!.studio_id).toBeNull();
  });

  it.each(["payment_off", "missing_project"] as const)("keeps the standalone charge pending when hold release fails for %s, and its retry applies it once", async (mode) => {
    const settle = entry();
    if (mode === "payment_off") payments(false);
    const fixture = await seed({ missingProject: mode === "missing_project" });
    const before = await snapshot(fixture);
    const cleanup = await installFault(fixture, "standalone_hold");
    try {
      expect(await settle(fixture.taskId)).toMatchObject({ state: "settled", first: true, chargeFailure: expect.anything() });
      pendingCharge(before, await snapshot(fixture), 0.03);
    } finally {
      await cleanup();
    }
    await settleCharge(await pendingRequest(fixture.taskId));
    const after = await snapshot(fixture);
    claimed(before, after, 0.03);
    expect(after.lot).toEqual(before.lot);
    expect(after.ledger).toHaveLength(1);
    expect(Number(after.ledger[0]!.amount)).toBe(-0.03);
  });

  it("notifies readers only after the entire parent transaction is externally visible", async () => {
    const settle = entry();
    const fixture = await seed();
    const before = await snapshot(fixture);
    const observed: Snapshot[] = [];
    vi.mocked(core.publishCreditsChanged).mockImplementation(async (projectId) => {
      expect(projectId).toBe(fixture.projectId);
      observed.push(await snapshot(fixture));
    });
    await settle(fixture.taskId);
    expect(core.publishCreditsChanged).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(1);
    claimed(before, observed[0]!, 0.03);
    expect(Number(observed[0]!.lot.remaining)).toBe(0.97);
    expect(observed[0]!.ledger).toHaveLength(1);
  });

  it("keeps a committed charge when notification fails and does not charge on replay", async () => {
    const settle = entry();
    const fixture = await seed();
    const before = await snapshot(fixture);
    vi.mocked(core.publishCreditsChanged).mockRejectedValueOnce(new Error("notification unavailable"));
    await settle(fixture.taskId);
    const once = await snapshot(fixture);
    claimed(before, once, 0.03);
    expect(Number(once.lot.remaining)).toBe(0.97);
    await settle(fixture.taskId);
    expect(await snapshot(fixture)).toEqual(once);
  });

  it("keeps the complete fee total invariant under persisted consumption ordering", async () => {
    const settle = entry();
    await fc.assert(fc.asyncProperty(fc.shuffledSubarray([0.011, 0.011, 0.003], { minLength: 3, maxLength: 3 }), async (rawCredits) => {
      const fixture = await seed({ rawCredits });
      const before = await snapshot(fixture);
      await settle(fixture.taskId);
      const after = await snapshot(fixture);
      claimed(before, after, 0.03);
      expect(Number(after.lot.remaining)).toBe(0.97);
      expect(after.ledger).toHaveLength(1);
      expect(Number(after.ledger[0]!.amount)).toBe(-0.03);
    }), { numRuns: 6 });
  });
});
