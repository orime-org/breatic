// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import crypto from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getMiniToolsConfig, initCore } from "@breatic/core";
import { miniToolConsumptionKey } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import type { MiniToolConsumptionRecord, MiniToolSettlement, MiniToolSettlementClaim } from "@domain/mini-tool/consumption.types.js";
import { waitUntilBlockedOn } from "../../../../server/src/__tests__/integration/lock-probe.js";

interface Fixture { taskId: string; stepId: string; fact: MiniToolConsumptionRecord; settlement: MiniToolSettlement; plan: unknown }
interface Claim {
  taskId: string; claim: MiniToolSettlementClaim; leaseUntil: string;
  parent: { status: string; consumptionSetComplete: boolean };
  nextConsumption: { stepId: string; consumption: MiniToolConsumptionRecord } | null;
}
interface Snapshot { task: { status: string; result: { settlement: MiniToolSettlement; manifest: unknown }; params: unknown; billed_at: string | null }; fact: MiniToolConsumptionRecord; usage: number }
let pg: ReturnType<typeof createPgClient>;
const PAST = "2026-10-24T09:03:03.100001Z";
const FUTURE = "2099-01-01T00:00:00.000000Z";
const RAW = { wallMs: 1000, cpuUsec: null };
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
 * Seed the independent oracle's failed parent and one container job pending on its report.
 * @param taskId - Optional fixed identity for the independent cursor tie-break cases.
 * @returns Its original persistent facts.
 * @throws {Error} When fixture insertion fails.
 */
async function seed(taskId: string = crypto.randomUUID()): Promise<Fixture> {
  const stepId = crypto.randomUUID();
  const userId = crypto.randomUUID(); const studioId = crypto.randomUUID(); const projectId = crypto.randomUUID();
  const inputId = crypto.randomUUID();
  const plan = { schemaVersion: 2, jobId: `original:${taskId}`, containerClass: "MiniToolContainerStd1", deadlineAt: Date.parse("2026-10-24T11:03:03.100001Z"),
    limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
    inputs: [{ inputId, storageKey: "original/input.mp4" }],
    outputs: [{ outputIndex: 0, storageKey: "original/frame.png", contentType: "image/png", recipe: { kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 42, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }] };
  const identity = { kind: "container", containerClass: plan.containerClass, jobId: plan.jobId, chunkIndex: 0 } as const;
  const fact: MiniToolConsumptionRecord = {
    schemaVersion: 1, consumptionKey: await miniToolConsumptionKey({ taskId, stepId, identity }), identity,
    state: "pending", creditMultiplier: 2, chargeTo: "user", costUsd: null, costSource: null, raw: null, credits: null,
    containerPricing: { configVersion: "first-price", size: { vcpu: 0.5, memory_gib: 4, disk_gb: 8 }, prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 } },
  };
  const settlement: MiniToolSettlement = { version: 7, state: "waiting", pendingConsumptionKeys: [fact.consumptionKey], nextAttemptAt: PAST, leaseToken: null, leaseUntil: null, lastError: null, consumptionSetComplete: true };
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${userId},${`${userId}@example.test`},true)`;
  await pg`INSERT INTO studios (id,created_by_user_id,slug,type,name) VALUES (${studioId},${userId},${`l-${studioId}`},'team','Lookup')`;
  await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${projectId},${studioId},${userId},${`l-${projectId}`},'Lookup')`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result) VALUES
    (${taskId},${userId},${projectId},${crypto.randomUUID()},'mini_tool_analysis','append','mini_tool','failed',
    ${pg.json({ deadlineAt: "2026-10-24T11:03:03.100001Z" })},${pg.json({ manifest: MANIFEST, settlement: { ...settlement } })})`;
  await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output) VALUES
    (${stepId},${taskId},0,'container_job',${plan.containerClass},'done',${pg.json({ miniToolConsumption: { ...fact }, miniToolPlanJob: plan })})`;
  return { taskId, stepId, fact, settlement, plan };
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
 * Confirm the container job's computed cost under the lookup's lease.
 * @param f - The original expense.
 * @param current - The lookup's original lease.
 * @param costUsd - Explicit confirmed expense including zero.
 * @returns The persisted expense state.
 * @throws {Error} When answer validation, the lease or persistence fails.
 */
async function confirm(f: Fixture, current: Claim, costUsd = 0.000055): Promise<MiniToolConsumptionRecord> {
  return invoke("confirmMiniToolConsumption", { taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim, costUsd, costSource: "computed", raw: RAW });
}

/**
 * The fixture's consumption once its report's cost is known.
 * @param f - The original expense.
 * @param usd - The computed cost.
 * @returns The known consumption.
 */
function knownFact(f: Fixture, usd = 0.000055): MiniToolConsumptionRecord {
  return { ...f.fact, state: "known", costUsd: usd, costSource: "computed", raw: RAW };
}

/**
 * A container report's lookup answering one computed cost.
 * @param usd - The computed cost.
 * @returns The answer.
 */
function lookedUp(usd: number): domain.MiniToolConsumptionLookup {
  return { state: "known", costUsd: usd, costSource: "computed", raw: RAW };
}

interface DueCursor { taskId: string; dueAt: string }
interface DueItem extends DueCursor { settlementVersion: number }
interface DuePage { items: DueItem[]; nextCursor: DueCursor | null }

/**
 * Ask the real repository for due SQL periods, without claiming any work.
 * @param limit - The independent page size.
 * @param cursor - An unmodified full-precision cursor from a previous page.
 * @returns Its due work and stable continuation.
 * @throws {Error} When the discovery entry is absent or rejects the request.
 */
async function due(limit: number, cursor?: DueCursor): Promise<DuePage> {
  return invoke("listDueMiniToolSettlements", { limit, ...(cursor === undefined ? {} : { cursor }) });
}

describe("immutable UTC settlement index semantics", () => {
  it.each([
    ["2026-10-24T09:03:03.100Z", "2026-10-24T09:03:03.100000Z"],
    ["2026-10-24T09:03:03.100000Z", "2026-10-24T09:03:03.100000Z"],
    ["2026-10-24T09:03:03.100001Z", "2026-10-24T09:03:03.100001Z"],
    ["2026-10-24T09:03Z", "2026-10-24T09:03:00.000000Z"],
    ["2026-10-24T09:03:03.1234564Z", "2026-10-24T09:03:03.123456Z"],
    ["2026-10-24T09:03:03.1234566Z", "2026-10-24T09:03:03.123457Z"],
    ["2026-10-24T09:03:59.9999999Z", "2026-10-24T09:04:00.000000Z"],
    ["2026-12-31T23:59:59.9999999Z", "2027-01-01T00:00:00.000000Z"],
    ["2024-02-29T23:59:59.9999999Z", "2024-03-01T00:00:00.000000Z"],
  ])("retains the original supported UTC instant %s", async (input, expected) => {
    for (const state of ["waiting", "checking"]) {
      const result = { settlement: { state, nextAttemptAt: state === "waiting" ? input : FUTURE, leaseUntil: state === "checking" ? input : FUTURE } };
      const [row] = await pg`SELECT to_char(mini_tool_settlement_due_at(${pg.json(result)}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
      expect(row).toEqual({ at: expected });
    }
  });

  it.each([null, "now", "today", "tomorrow", "epoch", "infinity", "-infinity", "2026-10-24T09:03:03+00:00", "2026-10-24T17:03:03+08:00",
    "2026-10-24T09:03:03", "2026-10-24t09:03:03z", " 2026-10-24T09:03:03Z", "2026-10-24T09:03:03Z ", "2026-02-30T09:03:03Z",
    "2026-10-24T24:00:00Z", "2026-10-24T09:60:00Z", "2026-10-24T09:03:60Z", "2026-10-24T09:03:03.Z",
  ])("never indexes relative, local or invalid date input %s", async (input) => {
    const [row] = await pg`SELECT mini_tool_settlement_due_at(${pg.json({ settlement: { state: "waiting", nextAttemptAt: input } })}) AS at`;
    expect(row).toEqual({ at: null });
  });

  it("does not derive a due time from unsupported or missing period facts", async () => {
    for (const value of [null, {}, { settlement: {} }, { settlement: { state: "idle", nextAttemptAt: PAST } }, { settlement: { state: "settled", leaseUntil: PAST } }]) {
      const [row] = await pg`SELECT mini_tool_settlement_due_at(${pg.json(value)}) AS at`;
      expect(row).toEqual({ at: null });
    }
  });

  it("keeps parsing independent of the caller's timezone and DateStyle without changing either", async () => {
    for (const timezone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
      for (const style of ["ISO,YMD", "SQL,DMY", "German,DMY"]) {
        await pg.begin(async (tx) => {
          await tx`SELECT set_config('TimeZone',${timezone},true),set_config('DateStyle',${style},true)`;
          const [before] = await tx`SELECT current_setting('TimeZone') AS tz,current_setting('DateStyle') AS style`;
          const [row] = await tx`SELECT to_char(mini_tool_settlement_due_at(${tx.json({ settlement: { state: "waiting", nextAttemptAt: "2026-10-24T09:03:03.100001Z" } })}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
          const [after] = await tx`SELECT current_setting('TimeZone') AS tz,current_setting('DateStyle') AS style`;
          expect(row).toEqual({ at: "2026-10-24T09:03:03.100001Z" }); expect(after).toEqual(before);
        });
      }
    }
  });

  it("keeps different legal fractional precision and UUID ties in one ordered query", async () => {
    const fixtures: Fixture[] = [];
    const instants = ["1880-01-01T00:00:00.100Z", "1880-01-01T00:00:00.100000Z", "1880-01-01T00:00:00.100001Z", "1880-01-01T00:00:00.100002Z"];
    for (const [index, instant] of instants.entries()) {
      const fixture = await seed(`b0000000-0000-4000-8000-00000000000${index + 1}`); fixtures.push(fixture);
      await setPeriod(fixture, { nextAttemptAt: instant });
    }
    const first = await due(2);
    expect(first.items).toEqual(fixtures.slice(0, 2).map((f) => ({ taskId: f.taskId, settlementVersion: 7, dueAt: "1880-01-01T00:00:00.100000Z" })));
    const second = await due(2, first.nextCursor!);
    expect(second.items).toEqual(fixtures.slice(2).map((f, index) => ({ taskId: f.taskId, settlementVersion: 7, dueAt: `1880-01-01T00:00:00.10000${index + 1}Z` })));
    for (const fixture of fixtures) await setPeriod(fixture, { state: "idle", nextAttemptAt: null, pendingConsumptionKeys: [] });
  });
});

describe("restart discovery reads durable mini-tool settlement periods", () => {
  it("finds waiting, expired claims and unbilled terminal periods without changing their facts", async () => {
    const waiting = await seed();
    const checking = await seed();
    const emptyTerminal = await seed();
    const future = await seed();
    const liveClaim = await seed();
    const idle = await seed();
    const settled = await seed();
    const billed = await seed();
    const legacy = await seed();
    const otherSource = await seed();
    for (const f of [waiting, checking, emptyTerminal, future, liveClaim, idle, settled, billed, otherSource]) {
      await setPeriod(f, { nextAttemptAt: "1990-01-01T00:00:00.100001Z" });
    }
    await setPeriod(checking, { state: "checking", nextAttemptAt: FUTURE, leaseToken: "expired", leaseUntil: "1990-01-01T00:00:00.100002Z" });
    await setPeriod(emptyTerminal, { nextAttemptAt: "1990-01-01T00:00:00.100003Z", pendingConsumptionKeys: [] });
    await pg`UPDATE tasks SET status='completed' WHERE id=${emptyTerminal.taskId}`;
    await setPeriod(future, { nextAttemptAt: FUTURE });
    await setPeriod(liveClaim, { state: "checking", leaseToken: "live", leaseUntil: FUTURE });
    await setPeriod(idle, { state: "idle", nextAttemptAt: null, pendingConsumptionKeys: [] });
    await setPeriod(settled, { state: "settled", nextAttemptAt: null, pendingConsumptionKeys: [] });
    await pg`UPDATE tasks SET billed_at=now(),billed_credits=0 WHERE id=${billed.taskId}`;
    await pg`UPDATE tasks SET result=${pg.json({ manifest: MANIFEST })} WHERE id=${legacy.taskId}`;
    await pg`UPDATE tasks SET source='user' WHERE id=${otherSource.taskId}`;
    const fixtures = [waiting, checking, emptyTerminal, future, liveClaim, idle, settled, billed, legacy, otherSource];
    const before = await Promise.all(fixtures.map(snapshot));
    const page = await due(1000);
    const ours = new Map(page.items.map((item) => [item.taskId, item]));
    expect(ours.get(waiting.taskId)).toEqual({ taskId: waiting.taskId, settlementVersion: 7, dueAt: "1990-01-01T00:00:00.100001Z" });
    expect(ours.get(checking.taskId)).toEqual({ taskId: checking.taskId, settlementVersion: 7, dueAt: "1990-01-01T00:00:00.100002Z" });
    expect(ours.get(emptyTerminal.taskId)).toEqual({ taskId: emptyTerminal.taskId, settlementVersion: 7, dueAt: "1990-01-01T00:00:00.100003Z" });
    for (const f of [future, liveClaim, idle, settled, billed, legacy, otherSource]) expect(ours.has(f.taskId)).toBe(false);
    expect(await Promise.all(fixtures.map(snapshot))).toEqual(before);
  });

  it("preserves SQL microseconds and the task UUID tie-break across limit-two pages", async () => {
    const ids = [1, 2, 3, 4].map((n) => `a0000000-0000-4000-8000-00000000000${n}`);
    const fixtures = [];
    for (const id of ids) fixtures.push(await seed(id));
    const instants = ["1980-01-01T00:00:00.100001Z", "1980-01-01T00:00:00.100001Z", "1980-01-01T00:00:00.100002Z", "1980-01-01T00:00:00.100003Z"];
    for (const [index, f] of fixtures.entries()) await setPeriod(f, { version: index + 10, nextAttemptAt: instants[index]! });
    const first = await due(2);
    expect(first.items).toEqual(ids.slice(0, 2).map((taskId, index) => ({ taskId, settlementVersion: index + 10, dueAt: instants[index] })));
    expect(first.nextCursor).toEqual({ taskId: ids[1], dueAt: instants[1] });
    const second = await due(2, first.nextCursor!);
    expect(second.items).toEqual(ids.slice(2).map((taskId, index) => ({ taskId, settlementVersion: index + 12, dueAt: instants[index + 2] })));
  });

  it("continues collecting an expense even when its task is hidden from user history", async () => {
    const f = await seed();
    await setPeriod(f, { nextAttemptAt: "1990-01-02T00:00:00.100001Z" });
    await pg`UPDATE tasks SET deleted_at=now() WHERE id=${f.taskId}`;
    expect((await due(1000)).items.some((item) => item.taskId === f.taskId)).toBe(true);
  });

  it("rejects invalid limits and lossy or malformed cursors before querying", async () => {
    const valid = { taskId: crypto.randomUUID(), dueAt: "1980-01-01T00:00:00.100001Z" };
    for (const input of [
      { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: Number.NaN },
      { limit: 1, cursor: { ...valid, taskId: "not-a-uuid" } },
      { limit: 1, cursor: { ...valid, dueAt: "1980-01-01" } },
      { limit: 1, cursor: { ...valid, dueAt: "1980-01-01T00:00:00.100Z" } },
    ]) await expect(invoke("listDueMiniToolSettlements", input)).rejects.toThrow();
  });

  it("retains generated equal-millisecond instants and UUID ties through different page sizes", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 4, maxLength: 4 }), fc.integer({ min: 1, max: 3 }), async (micros, limit) => {
      const fixtures: Fixture[] = [];
      try {
        for (const micro of micros) {
          const f = await seed(); fixtures.push(f);
          await setPeriod(f, { nextAttemptAt: `1900-01-01T00:00:00.10000${micro}Z` });
        }
        const expected = fixtures.map((f, index) => ({ taskId: f.taskId, dueAt: `1900-01-01T00:00:00.10000${micros[index]}Z`, settlementVersion: 7 }))
          .sort((a, b) => a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
        const ours = new Set(fixtures.map((f) => f.taskId));
        const found: DueItem[] = [];
        let cursor: DueCursor | undefined;
        for (let pageIndex = 0; pageIndex < 10 && found.length < expected.length; pageIndex += 1) {
          const page = await due(limit, cursor);
          found.push(...page.items.filter((item) => ours.has(item.taskId)));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect(found).toEqual(expected);
      } finally {
        for (const f of fixtures) await setPeriod(f, { state: "idle", nextAttemptAt: null, pendingConsumptionKeys: [] });
      }
    }), { numRuns: 8 });
  });
});

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
    const fact = { ...knownFact(f), state, credits: state === "recorded" ? 0.011 : null };
    await pg`UPDATE task_upstream_steps SET output=${pg.json({ miniToolConsumption: fact })} WHERE id=${f.stepId}`;
    if (state === "recorded") await setPeriod(f, { pendingConsumptionKeys: [] });
    const current = await claim(f);
    expect(current!.nextConsumption).toEqual(state === "known" ? { stepId: f.stepId, consumption: fact } : null);
    expect((await snapshot(f)).usage).toBe(0);
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
    expect(await confirm(f, current)).toEqual(knownFact(f));
    const known = await snapshot(f); expect(known.usage).toBe(0); expect(known.task.result.settlement).toMatchObject({ version: 7, state: "checking", leaseToken: current.claim.leaseToken });
    await domain.recordMiniToolConsumption({ taskId: f.taskId, stepId: f.stepId, identity: f.fact.identity, claim: current.claim });
    const recorded = await snapshot(f); expect(recorded.usage).toBe(1); expect(recorded.fact.state).toBe("recorded");
    expect(recorded.task.result.settlement).toMatchObject({ version: 8, state: "waiting", pendingConsumptionKeys: [], leaseToken: null, leaseUntil: null });
    // The old cycle's lease no longer holds, so a late confirmation changes nothing.
    await confirm(f, current, 99); expect(await snapshot(f)).toEqual(recorded);
  });

  it("accepts explicit zero without inventing usage before recording", async () => {
    const f = await seed(); const current = (await claim(f))!; await confirm(f, current, 0);
    expect((await snapshot(f)).fact).toMatchObject({ state: "known", costUsd: 0, credits: null });
    expect((await snapshot(f)).usage).toBe(0);
  });

  it.each(["expired", "version", "token", "step"])("refuses a late answer with stale %s", async (kind) => {
    const f = await seed(); const current = (await claim(f))!;
    if (kind === "expired") await setPeriod(f, { state: "checking", leaseToken: current.claim.leaseToken, leaseUntil: PAST });
    if (kind === "version") current.claim.version = 6;
    if (kind === "token") current.claim.leaseToken = "other-token";
    const before = await snapshot(f);
    await invoke("confirmMiniToolConsumption", { taskId: f.taskId, stepId: kind === "step" ? crypto.randomUUID() : f.stepId, identity: f.fact.identity, claim: current.claim,
      costUsd: 0.000055, costSource: "computed", raw: RAW }).catch(() => undefined);
    expect(await snapshot(f)).toEqual(before);
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

describe("durable expense recovery orchestration", () => {
  it("ignores a stale wake without querying or writing and returns the current SQL wake", async () => {
    const f = await seed(); const before = await snapshot(f); const lookup = vi.fn();
    const result = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 6 }, lookup);
    expect(result).toEqual({ charge: null, nextWake: { taskId: f.taskId, settlementVersion: 7, dueAt: PAST } });
    expect(lookup).not.toHaveBeenCalled(); expect(await snapshot(f)).toEqual(before);
  });

  it("recovers an expired owner before returning its newly committed version", async () => {
    const f = await seed(); await setPeriod(f, { state: "checking", leaseToken: "expired", leaseUntil: PAST });
    const lookup = vi.fn();
    const result = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(result.nextWake).toMatchObject({ taskId: f.taskId, settlementVersion: 8, dueAt: expect.any(String) });
    expect(result.charge).toBeNull(); expect(lookup).not.toHaveBeenCalled();
    expect((await snapshot(f)).fact).toEqual(f.fact);
  });

  it("keeps an unpriced answer pending and schedules its persisted retry period", async () => {
    const f = await seed(); const lookup = vi.fn(async (): Promise<domain.MiniToolConsumptionLookup> => ({ state: "pending", reason: "report-unpriced" }));
    const result = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(lookup).toHaveBeenCalledExactlyOnceWith({ consumption: f.fact, plan: f.plan });
    expect(result).toMatchObject({ charge: null, nextWake: { taskId: f.taskId, settlementVersion: 8, dueAt: expect.any(String) } });
    const after = await snapshot(f); expect(after.fact).toEqual(f.fact); expect(after.usage).toBe(0);
    expect(after.task.result.settlement).toMatchObject({ state: "waiting", version: 8, pendingConsumptionKeys: [f.fact.consumptionKey], leaseToken: null });
    expect(after.task.result.manifest).toEqual(MANIFEST); expect(after.task.status).toBe("failed");
  });

  it("records a confirmed zero once, then settles the terminal parent in its next cycle", async () => {
    const f = await seed(); const lookup = vi.fn(async () => lookedUp(0));
    const first = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(first).toMatchObject({ charge: null, nextWake: { taskId: f.taskId, settlementVersion: 8 } });
    const recorded = await snapshot(f); expect(recorded.fact).toMatchObject({ state: "recorded", costUsd: 0, credits: 0 }); expect(recorded.usage).toBe(1);
    expect(recorded.task.billed_at).toBeNull();
    const second = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 8 }, lookup);
    expect(second).toMatchObject({ nextWake: null, charge: { state: "settled", credits: 0, first: true } });
    expect(lookup).toHaveBeenCalledTimes(1);
    const settled = await snapshot(f); expect(settled.task.billed_at).not.toBeNull(); expect(settled.task.result.manifest).toEqual(MANIFEST);
    await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 8 }, lookup);
    expect(await snapshot(f)).toEqual(settled); expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("records an already known fact without asking upstream again", async () => {
    const f = await seed(); const lookup = vi.fn();
    await pg`UPDATE task_upstream_steps SET output=${pg.json({ miniToolConsumption: knownFact(f) })} WHERE id=${f.stepId}`;
    const result = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(lookup).not.toHaveBeenCalled(); expect((await snapshot(f)).usage).toBe(1);
    expect(result).toMatchObject({ charge: null, nextWake: { taskId: f.taskId, settlementVersion: 8 } });
  });

  it("retains a lookup failure and its original pending expense for a later cycle", async () => {
    const f = await seed(); const error = new Error("billing transport unavailable"); const lookup = vi.fn(async () => { throw error; });
    const result = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(result.failure).toBe(error); expect(result.nextWake).toMatchObject({ taskId: f.taskId, settlementVersion: 8 });
    const after = await snapshot(f); expect(after.fact).toEqual(f.fact); expect(after.usage).toBe(0);
    expect(after.task.result.settlement).toMatchObject({ state: "waiting", version: 8, lastError: error.message });
    // The failed cycle waits its retry delay rather than coming back at once.
    expect(Date.parse(after.task.result.settlement.nextAttemptAt!)).toBeGreaterThan(Date.now());
  });

  it("commits the lease before external IO and ignores an answer invalidated during that IO", async () => {
    const f = await seed(); let entered!: () => void; let release!: (answer: domain.MiniToolConsumptionLookup) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const external = new Promise<domain.MiniToolConsumptionLookup>((resolve) => { release = resolve; });
    const lookup = vi.fn(async () => { entered(); return external; });
    const running = domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    void running.catch(() => undefined);
    await Promise.race([started, running.then(() => { throw new Error("Recovery returned without entering the required lookup"); })]);
    try {
      await pg.begin(async (tx) => {
        await tx.unsafe("SET LOCAL statement_timeout='2s'");
        await tx`UPDATE tasks SET result=jsonb_set(result,'{settlement}',${tx.json({ ...f.settlement, version: 8 })}) WHERE id=${f.taskId}`;
      });
    } finally { release(lookedUp(99)); }
    const result = await running;
    expect(lookup).toHaveBeenCalledTimes(1); expect(result.nextWake).toEqual({ taskId: f.taskId, settlementVersion: 8, dueAt: PAST });
    const after = await snapshot(f); expect(after.fact).toEqual(f.fact); expect(after.usage).toBe(0); expect(after.task.result.manifest).toEqual(MANIFEST);
  });

  it("retains known cost after usage failure so the next cycle performs no second lookup", async () => {
    const f = await seed(); const lookup = vi.fn(async () => lookedUp(0.000055));
    await pg.unsafe("CREATE OR REPLACE FUNCTION fail_runner_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced runner usage failure'; END $$");
    await pg.unsafe("CREATE TRIGGER fail_runner_usage BEFORE INSERT ON agent_usage_records FOR EACH ROW EXECUTE FUNCTION fail_runner_usage()");
    let first: domain.MiniToolSettlementRunResult;
    try { first = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup); }
    finally {
      await pg.unsafe("DROP TRIGGER fail_runner_usage ON agent_usage_records"); await pg.unsafe("DROP FUNCTION fail_runner_usage()");
    }
    expect(first.failure).toBeInstanceOf(Error); expect(first.nextWake).toMatchObject({ taskId: f.taskId, settlementVersion: 8 });
    const known = await snapshot(f); expect(known.fact).toMatchObject({ state: "known", costUsd: 0.000055, credits: null }); expect(known.usage).toBe(0);
    await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement,nextAttemptAt}',to_jsonb(${PAST}::text)) WHERE id=${f.taskId}`;
    await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 8 }, lookup);
    expect(lookup).toHaveBeenCalledTimes(1); expect((await snapshot(f)).fact.state).toBe("recorded"); expect((await snapshot(f)).usage).toBe(1);
  });

  it("does not settle an empty terminal list whose consumption set is not explicitly complete", async () => {
    const f = await seed(); const lookup = vi.fn();
    await setPeriod(f, { pendingConsumptionKeys: [], consumptionSetComplete: false });
    await pg`UPDATE task_upstream_steps SET output='{}'::jsonb WHERE id=${f.stepId}`;
    const result = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(result).toMatchObject({ charge: { state: "pending" }, nextWake: { taskId: f.taskId, settlementVersion: 8 } });
    expect(lookup).not.toHaveBeenCalled();
    const [task] = await pg`SELECT billed_at,result FROM tasks WHERE id=${f.taskId}`;
    expect(task!.billed_at).toBeNull(); expect(task!.result.manifest).toEqual(MANIFEST);
  });

  it("records only one known expense per claim and rounds the complete parent once", async () => {
    const f = await seed(); const lookup = vi.fn(); const otherStep = crypto.randomUUID();
    const identity = { ...f.fact.identity, jobId: `second:${f.taskId}` } as const;
    const secondKey = await miniToolConsumptionKey({ taskId: f.taskId, stepId: otherStep, identity });
    const first = knownFact(f);
    const second = { ...first, identity, consumptionKey: secondKey };
    await pg`UPDATE task_upstream_steps SET output=${pg.json({ miniToolConsumption: first })} WHERE id=${f.stepId}`;
    await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output) VALUES
      (${otherStep},${f.taskId},1,'container_job','MiniToolContainerStd1','done',${pg.json({ miniToolConsumption: second })})`;
    await setPeriod(f, { pendingConsumptionKeys: [f.fact.consumptionKey, secondKey] });
    await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect((await snapshot(f)).task.result.settlement).toMatchObject({ version: 8, pendingConsumptionKeys: [secondKey] });
    const [untouched] = await pg`SELECT output->'miniToolConsumption' AS fact FROM task_upstream_steps WHERE id=${otherStep}`;
    expect(untouched!.fact).toEqual(second);
    await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 8 }, lookup);
    expect((await snapshot(f)).task.result.settlement).toMatchObject({ version: 9, pendingConsumptionKeys: [] });
    const last = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 9 }, lookup);
    expect(last).toMatchObject({ nextWake: null, charge: { state: "settled", credits: 0.03, first: true } });
    expect(lookup).not.toHaveBeenCalled();
    const [usage] = await pg`SELECT count(*)::int AS count FROM agent_usage_records WHERE operation_key IN (${f.fact.consumptionKey},${secondKey})`;
    expect(usage).toEqual({ count: 2 });
  });

  // A job frame recipe names a grid frame of the frozen grid, the tool source and its PNG target (frames-split §7.16).
  it("reads a container through its complete original plan after computation ended", async () => {
    const f = await seed(); const inputId = crypto.randomUUID();
    const plan = { schemaVersion: 2, jobId: `original:${f.taskId}`, containerClass: "MediaContainer", deadlineAt: Date.parse("2026-10-24T11:03:03.100001Z"),
      limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
      inputs: [{ inputId, storageKey: "original/input.mp4" }],
      outputs: [{ outputIndex: 8, storageKey: "original/frame.png", contentType: "image/png", recipe: { kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } }, frameIndex: 42, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }] };
    const identity = { kind: "container", containerClass: plan.containerClass, jobId: plan.jobId, chunkIndex: 1 } as const;
    const fact = { schemaVersion: 1, identity, consumptionKey: await miniToolConsumptionKey({ taskId: f.taskId, stepId: f.stepId, identity }),
      state: "pending", creditMultiplier: 2, chargeTo: "user", costUsd: null, costSource: null, raw: null, credits: null,
      containerPricing: { configVersion: "first-price", size: { vcpu: 8, memory_gib: 2, disk_gb: 4 }, prices: { vcpu_second_usd: 0.001, memory_gib_second_usd: 0.002, disk_gb_second_usd: 0.003 } } };
    await pg`UPDATE task_upstream_steps SET kind='container_job',endpoint=${plan.containerClass},prediction_id=NULL,output=${pg.json({ miniToolConsumption: fact, miniToolPlanJob: plan })} WHERE id=${f.stepId}`;
    await setPeriod(f, { pendingConsumptionKeys: [fact.consumptionKey] });
    const lookup = vi.fn(async () => ({ state: "known" as const, costUsd: 0.0325, costSource: "computed" as const, raw: { wallMs: 2000, cpuUsec: 500000 } }));
    const result = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(lookup).toHaveBeenCalledExactlyOnceWith({ consumption: fact, plan });
    expect(result).toMatchObject({ charge: null, nextWake: { taskId: f.taskId, settlementVersion: 8 } });
    const after = await snapshot(f); expect(after.fact).toMatchObject({ state: "recorded", costUsd: 0.0325, containerPricing: fact.containerPricing });
    expect(after.task.status).toBe("failed"); expect(after.task.result.manifest).toEqual(MANIFEST);
  });

  it("keeps lookup, usage and the committed zero charge idempotent under generated stale deliveries", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.boolean(), async (repeats, completed) => {
      const f = await seed();
      if (completed) await pg`UPDATE tasks SET status='completed' WHERE id=${f.taskId}`;
      const lookup = vi.fn(async () => lookedUp(0));
      await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
      const recorded = await snapshot(f);
      for (let index = 0; index < repeats; index += 1) await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
      expect(await snapshot(f)).toEqual(recorded);
      expect((await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 8 }, lookup)).charge).toMatchObject({ state: "settled", credits: 0 });
      const settled = await snapshot(f);
      for (let index = 0; index < repeats; index += 1) await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 8 }, lookup);
      expect(await snapshot(f)).toEqual(settled); expect(settled.usage).toBe(1); expect(lookup).toHaveBeenCalledTimes(1);
      expect(settled.task.status).toBe(completed ? "completed" : "failed"); expect(settled.task.result.manifest).toEqual(MANIFEST);
    }), { numRuns: 6 });
  });

  it("keeps the SQL lease recoverable when persisting a failed lookup's retry also fails", async () => {
    const f = await seed(); const lookup = vi.fn(async () => { throw new Error("upstream unavailable"); });
    await pg.unsafe(`CREATE OR REPLACE FUNCTION fail_runner_defer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${f.taskId}'::uuid AND NEW.result->'settlement'->>'state'='waiting' THEN RAISE EXCEPTION 'forced retry persistence failure'; END IF;
      RETURN NEW; END $$`);
    await pg.unsafe("CREATE TRIGGER fail_runner_defer BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION fail_runner_defer()");
    try { await expect(domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup)).rejects.toThrow(); }
    finally {
      await pg.unsafe("DROP TRIGGER fail_runner_defer ON tasks"); await pg.unsafe("DROP FUNCTION fail_runner_defer()");
    }
    const retained = await snapshot(f); expect(retained.fact).toEqual(f.fact); expect(retained.usage).toBe(0);
    expect(retained.task.result.settlement).toMatchObject({ state: "checking", version: 7, pendingConsumptionKeys: [f.fact.consumptionKey], leaseToken: expect.any(String) });
    expect(retained.task.result.manifest).toEqual(MANIFEST); expect(retained.task.billed_at).toBeNull();
    await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement,leaseUntil}',to_jsonb(${PAST}::text)) WHERE id=${f.taskId}`;
    const recovered = await domain.runMiniToolSettlement({ taskId: f.taskId, settlementVersion: 7 }, lookup);
    expect(recovered.nextWake).toMatchObject({ taskId: f.taskId, settlementVersion: 8 }); expect(lookup).toHaveBeenCalledTimes(1);
  });
});
