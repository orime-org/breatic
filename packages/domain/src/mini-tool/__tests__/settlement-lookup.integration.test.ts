// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import crypto from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, getMiniToolsConfig, initCore } from "@breatic/core";
import { miniToolConsumptionKey } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import type { MiniToolConsumptionRecord, MiniToolSettlement, MiniToolSettlementClaim } from "@domain/mini-tool/consumption.types.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

interface Fixture { taskId: string; stepId: string; fact: MiniToolConsumptionRecord; settlement: MiniToolSettlement }
interface Claim {
  taskId: string; claim: MiniToolSettlementClaim; leaseUntil: string;
  parent: { status: string; consumptionSetComplete: boolean };
  nextConsumption: { stepId: string; consumption: MiniToolConsumptionRecord } | null;
}
interface Snapshot { task: { status: string; result: { settlement: MiniToolSettlement; manifest: unknown }; params: unknown; billed_at: string | null }; fact: MiniToolConsumptionRecord; usage: number }
let pg: ReturnType<typeof createPgClient>;
const PAST = "2026-10-24T09:03:03.100001Z";
const FUTURE = "2099-01-01T00:00:00.000000Z";
const MANIFEST = { outputs: [{ outputIndex: 0, registeredUrl: "https://assets.test.invalid/kept.mp4" }] };

beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false" });
  pg = createPgClient(inject("DATABASE_URL"), { name: "mini-tool-lookup-fixtures", max: 4 });
});
afterAll(async () => { await pg.end(); });

/**
 * Reach a future API through the existing public entry without a load-time missing export.
 * @param name - The required production entry.
 * @param input - Its typed request at the transport-independent domain boundary.
 * @returns Its persistent decision.
 * @throws {Error} When the entry is absent or rejects the operation.
 */
async function invoke<T>(name: string, input: unknown): Promise<T> {
  const fn: unknown = Reflect.get(domain, name);
  expect(fn, `domain exports ${name}`).toBeTypeOf("function");
  return (fn as (value: unknown) => Promise<T>)(input);
}

/**
 * Seed the independent oracle's failed parent and one actual provider identity.
 * @returns Its original persistent facts.
 * @throws {Error} When fixture insertion fails.
 */
async function seed(): Promise<Fixture> {
  const taskId = crypto.randomUUID(); const stepId = crypto.randomUUID();
  const userId = crypto.randomUUID(); const studioId = crypto.randomUUID(); const projectId = crypto.randomUUID();
  const identity = { kind: "provider", provider: "wavespeed", predictionId: `prediction-${taskId}` } as const;
  const fact: MiniToolConsumptionRecord = {
    schemaVersion: 1, consumptionKey: await miniToolConsumptionKey({ taskId, stepId, identity }), identity,
    state: "pending", creditMultiplier: 2, chargeTo: "user", costUsd: null, costSource: null, raw: null, credits: null, containerPricing: null,
  };
  const settlement: MiniToolSettlement = { version: 7, state: "waiting", pendingConsumptionKeys: [fact.consumptionKey], nextAttemptAt: PAST, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: true };
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${userId},${`${userId}@example.test`},true)`;
  await pg`INSERT INTO studios (id,created_by_user_id,slug,type,name) VALUES (${studioId},${userId},${`l-${studioId}`},'team','Lookup')`;
  await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${projectId},${studioId},${userId},${`l-${projectId}`},'Lookup')`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result) VALUES
    (${taskId},${userId},${projectId},${crypto.randomUUID()},'mini_tool_analysis','append','mini_tool','failed',
    ${pg.json({ deadlineAt: "2026-10-24T11:03:03.100001Z" })},${pg.json({ manifest: MANIFEST, settlement: { ...settlement } })})`;
  await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,prediction_id,output) VALUES
    (${stepId},${taskId},0,'generate','wavespeed-ai/sam3-video-rle','done',${identity.predictionId},${pg.json({ miniToolConsumption: { ...fact } })})`;
  return { taskId, stepId, fact, settlement };
}

/**
 * Replace only the fixture period to exercise independent state-table rows.
 * @param f - The owning task.
 * @param patch - The oracle's state override.
 * @returns Nothing.
 * @throws {Error} When SQL fixture setup fails.
 */
async function setPeriod(f: Fixture, patch: Partial<MiniToolSettlement>): Promise<void> {
  await pg`UPDATE tasks SET result = result || ${pg.json({ settlement: { ...f.settlement, ...patch } })} WHERE id=${f.taskId}`;
}

/**
 * Observe expense, unrelated result and funds through a separate PostgreSQL pool.
 * @param f - The persisted identity.
 * @returns The current durable facts.
 * @throws {Error} When fixture state is incomplete.
 */
async function snapshot(f: Fixture): Promise<Snapshot> {
  const [task] = await pg<Snapshot["task"][]>`SELECT status,result,params,billed_at::text FROM tasks WHERE id=${f.taskId}`;
  const [step] = await pg<{ fact: MiniToolConsumptionRecord }[]>`SELECT output->'miniToolConsumption' AS fact FROM task_upstream_steps WHERE id=${f.stepId}`;
  const [usage] = await pg<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key=${f.fact.consumptionKey}`;
  if (!task || !step || !usage) throw new Error("Incomplete lookup fixture");
  return { task, fact: step.fact, usage: usage.count };
}

/**
 * Claim the current SQL cycle.
 * @param f - The original task identity.
 * @param version - The wake message's cycle.
 * @returns The committed lease or an ignored wake.
 * @throws {Error} When claiming fails.
 */
async function claim(f: Fixture, version = 7): Promise<Claim | null> {
  return invoke("claimMiniToolSettlement", { taskId: f.taskId, settlementVersion: version });
}

/**
 * Submit a fixed original-prediction billing answer.
 * @param f - The original expense.
 * @param current - The lookup's original lease.
 * @param costUsd - Explicit confirmed expense including zero.
 * @returns The persisted expense state.
 * @throws {Error} When answer validation or persistence fails.
 */
async function confirm(f: Fixture, current: Claim, costUsd = 0.000055): Promise<MiniToolConsumptionRecord> {
  return invoke("confirmMiniToolConsumption", { taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim, costUsd, costSource: "generation_lookup", raw: { deductUsd: costUsd, refundUsd: 0 } });
}

describe("persistent mini-tool lookup cycles", () => {
  it("ignores a wake for an absent task", async () => {
    expect(await invoke("claimMiniToolSettlement", { taskId: crypto.randomUUID(), settlementVersion: 7 })).toBeNull();
  });

  it.each(["legacy", "settled"])("leaves an unrelated %s wake unchanged", async (kind) => {
    const f = await seed();
    if (kind === "legacy") await pg`UPDATE tasks SET result=${pg.json({ manifest: MANIFEST })} WHERE id=${f.taskId}`;
    else {
      const current = (await claim(f))!;
      await confirm(f, current);
      await domain.recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim });
      await domain.settleMiniToolCharge(f.taskId);
    }
    const before = await snapshot(f); expect(await claim(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
  });

  it.each(["known", "recorded"] as const)("selects only outstanding consumption when the first fact is %s", async (state) => {
    const f = await seed();
    const fact = { ...f.fact, state, costUsd: 0.000055, costSource: "generation_lookup", raw: { deductUsd: 0.000055, refundUsd: 0 }, credits: state === "recorded" ? 0.011 : null };
    await pg`UPDATE task_upstream_steps SET output=${pg.json({ miniToolConsumption: fact })} WHERE id=${f.stepId}`;
    if (state === "recorded") await setPeriod(f, { pendingConsumptionKeys: [] });
    const current = await claim(f);
    expect(current!.nextConsumption).toEqual(state === "known" ? { stepId: f.stepId, consumption: fact } : null);
    expect((await snapshot(f)).usage).toBe(0);
  });

  it("rejects a provider expense attributed to the container cost source", async () => {
    const f = await seed(); const current = (await claim(f))!; const before = await snapshot(f);
    await expect(invoke("confirmMiniToolConsumption", { taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim, costUsd: 0.000055, costSource: "computed", raw: { wallMs: 1000 } })).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it("rolls back confirmation when its step write waits beyond the SQL lease", async () => {
    const f = await seed(); const current = (await claim(f))!;
    const advisoryKey = crypto.randomInt(1, 2 ** 30);
    let release!: () => void; let start!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { start = resolve; });
    const held = pg.begin(async (tx) => { await tx`SELECT pg_advisory_xact_lock(${advisoryKey})`; start(); await gate; });
    await locked;
    await pg.unsafe(`CREATE OR REPLACE FUNCTION block_lookup_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${f.stepId}'::uuid THEN PERFORM pg_advisory_xact_lock(${advisoryKey}); END IF; RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER block_lookup_confirmation BEFORE UPDATE ON task_upstream_steps FOR EACH ROW EXECUTE FUNCTION block_lookup_confirmation()");
    await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement,leaseUntil}',to_jsonb(to_char((clock_timestamp()+interval '2 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) WHERE id=${f.taskId}`;
    const before = await snapshot(f);
    const [stepBefore] = await pg`SELECT updated_at::text FROM task_upstream_steps WHERE id=${f.stepId}`;
    const confirmation = confirm(f, current);
    // Attach immediately; the original promise is still asserted below.
    void confirmation.catch(() => undefined);
    try {
      try {
        await waitUntilBlockedOn(pg, ["task_upstream_steps", "update"], 1);
        await pg`SELECT pg_sleep(greatest(0,extract(epoch FROM (result->'settlement'->>'leaseUntil')::timestamptz-clock_timestamp()))+0.01) FROM tasks WHERE id=${f.taskId}`;
      } finally { release(); }
      await held;
      await expect(confirmation).rejects.toThrow();
      expect(await snapshot(f)).toEqual(before);
      const [stepAfter] = await pg`SELECT updated_at::text FROM task_upstream_steps WHERE id=${f.stepId}`;
      expect(stepAfter).toEqual(stepBefore);
    } finally {
      release(); await held; await confirmation.catch(() => undefined);
      await pg.unsafe("DROP TRIGGER block_lookup_confirmation ON task_upstream_steps");
      await pg.unsafe("DROP FUNCTION block_lookup_confirmation()");
    }
  });

  it("claims one due cycle without incrementing its version or touching computation", async () => {
    const f = await seed(); const before = await snapshot(f);
    const [clock] = await pg<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
    const current = await claim(f);
    expect(current).toMatchObject({ taskId: f.taskId, claim: { version: 7, leaseToken: expect.any(String) }, parent: { status: "failed", consumptionSetComplete: true }, nextConsumption: { stepId: f.stepId, consumption: f.fact } });
    const after = await snapshot(f);
    const [timing] = await pg<{ valid: boolean }[]>`SELECT ${current!.leaseUntil}::text::timestamptz BETWEEN
      ${clock!.at}::text::timestamptz + ${getMiniToolsConfig().settlement.lease_ms} * interval '1 millisecond'
      AND clock_timestamp() + ${getMiniToolsConfig().settlement.lease_ms} * interval '1 millisecond' AS valid`;
    expect(timing).toEqual({ valid: true });
    expect(after.task).toEqual({ ...before.task, result: { ...before.task.result, settlement: { ...f.settlement, state: "checking", leaseToken: current!.claim.leaseToken, leaseUntil: current!.leaseUntil } } });
    expect(after.fact).toEqual(f.fact); expect(after.usage).toBe(0);
    expect(await claim(f)).toBeNull(); expect(await snapshot(f)).toEqual(after);
  });

  it.each([
    { state: "waiting" as const, nextAttemptAt: FUTURE },
    { state: "checking" as const, leaseToken: "active", leaseUntil: FUTURE },
    { state: "idle" as const, pendingConsumptionKeys: [], nextAttemptAt: null },
    { state: "settled" as const, pendingConsumptionKeys: [], nextAttemptAt: null },
  ])("ignores a wake in $state without a due unclaimed cycle", async (patch) => {
    const f = await seed(); await setPeriod(f, patch); const before = await snapshot(f);
    expect(await claim(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
  });

  it("ignores every stale version without a write", async () => {
    const f = await seed(); const before = await snapshot(f);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 6 }), async (version) => {
      expect(await claim(f, version)).toBeNull(); expect(await snapshot(f)).toEqual(before);
    }), { numRuns: 12 });
  });

  it("renews an expired lease into a new waiting cycle before a new claim", async () => {
    const f = await seed(); await setPeriod(f, { state: "checking", leaseToken: "expired", leaseUntil: PAST });
    expect(await claim(f)).toBeNull();
    const after = await snapshot(f);
    expect(after.task.result.settlement).toMatchObject({ state: "waiting", version: 8, leaseToken: null, leaseUntil: null, pendingConsumptionKeys: [f.fact.consumptionKey] });
    expect(await claim(f)).toBeNull();
    expect(await claim(f, 8)).toMatchObject({ claim: { version: 8, leaseToken: expect.any(String) } });
  });

  it("serializes two claims on the immutable task row", async () => {
    const f = await seed(); let release!: () => void; let start!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { start = resolve; });
    const held = pg.begin(async (tx) => { await tx`SELECT id FROM tasks WHERE id=${f.taskId} FOR UPDATE`; start(); await gate; });
    await locked; const first = claim(f); const second = claim(f);
    try { await waitUntilBlockedOn(pg, ["tasks", "for update"], 2); } finally { release(); }
    await held; const results = await Promise.all([first, second]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await snapshot(f)).task.result.settlement).toMatchObject({ version: 7, state: "checking" });
  });

  it("persists known before usage, then invalidates the old cycle on recording", async () => {
    const f = await seed(); const current = (await claim(f))!;
    expect(await confirm(f, current)).toEqual({ ...f.fact, state: "known", costUsd: 0.000055, costSource: "generation_lookup", raw: { deductUsd: 0.000055, refundUsd: 0 } });
    const known = await snapshot(f); expect(known.usage).toBe(0); expect(known.task.result.settlement).toMatchObject({ version: 7, state: "checking", leaseToken: current.claim.leaseToken });
    await domain.recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim });
    const recorded = await snapshot(f); expect(recorded.usage).toBe(1); expect(recorded.fact.state).toBe("recorded");
    expect(recorded.task.result.settlement).toMatchObject({ version: 8, state: "waiting", pendingConsumptionKeys: [], leaseToken: null, leaseUntil: null });
    await confirm(f, current, 99); expect(await snapshot(f)).toEqual(recorded);
  });

  it("accepts explicit zero without inventing usage before recording", async () => {
    const f = await seed(); const current = (await claim(f))!; await confirm(f, current, 0);
    expect((await snapshot(f)).fact).toMatchObject({ state: "known", costUsd: 0, credits: null });
    expect((await snapshot(f)).usage).toBe(0);
  });

  it.each(["expired", "version", "token", "identity"])("ignores a late answer with stale %s", async (kind) => {
    const f = await seed(); const current = (await claim(f))!;
    if (kind === "expired") await setPeriod(f, { state: "checking", leaseToken: current.claim.leaseToken, leaseUntil: PAST });
    if (kind === "version") current.claim.version = 6;
    if (kind === "token") current.claim.leaseToken = "other-token";
    if (kind === "identity") f.fact.identity = { kind: "provider", provider: "wavespeed", predictionId: "different-prediction" };
    const before = await snapshot(f); await confirm(f, current); expect(await snapshot(f)).toEqual(before);
  });

  it("preserves the first confirmed amount on a repeated answer", async () => {
    const f = await seed(); const current = (await claim(f))!; await confirm(f, current);
    const before = await snapshot(f); await confirm(f, current, 99); expect(await snapshot(f)).toEqual(before);
  });

  it("defers pending cost with a new cycle, retaining its expense and media result", async () => {
    const f = await seed(); const current = (await claim(f))!;
    expect(await invoke("deferMiniToolSettlement", { taskId: f.taskId, claim: current.claim, lastError: "billing-pending" })).toBe(true);
    const after = await snapshot(f); expect(after.fact).toEqual(f.fact); expect(after.usage).toBe(0);
    expect(after.task.status).toBe("failed"); expect(after.task.result.manifest).toEqual(MANIFEST);
    expect(after.task.result.settlement).toMatchObject({ version: 8, state: "waiting", pendingConsumptionKeys: [f.fact.consumptionKey], leaseToken: null, leaseUntil: null, lastError: "billing-pending" });
    expect(await claim(f, 8)).toBeNull();
    expect(await invoke("deferMiniToolSettlement", { taskId: f.taskId, claim: current.claim, lastError: "old-error" })).toBe(false);
    expect(await snapshot(f)).toEqual(after);
  });

  it.each([-1, NaN, Infinity])("rejects invalid confirmed cost %s without changing pending", async (costUsd) => {
    const f = await seed(); const current = (await claim(f))!; const before = await snapshot(f);
    await expect(confirm(f, current, costUsd)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
  });

  it("retains confirmed cost when usage fails and retries without a second lookup", async () => {
    const f = await seed(); const current = (await claim(f))!; await confirm(f, current);
    await pg.unsafe("CREATE OR REPLACE FUNCTION fail_lookup_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced lookup usage failure'; END $$");
    await pg.unsafe("CREATE TRIGGER fail_lookup_usage BEFORE INSERT ON agent_usage_records FOR EACH ROW EXECUTE FUNCTION fail_lookup_usage()");
    try { await expect(domain.recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim })).rejects.toThrow(); }
    finally { await pg.unsafe("DROP TRIGGER fail_lookup_usage ON agent_usage_records"); await pg.unsafe("DROP FUNCTION fail_lookup_usage()"); }
    expect((await snapshot(f)).fact.state).toBe("known"); expect((await snapshot(f)).usage).toBe(0);
    await domain.recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim });
    expect((await snapshot(f)).usage).toBe(1);
  });
});
