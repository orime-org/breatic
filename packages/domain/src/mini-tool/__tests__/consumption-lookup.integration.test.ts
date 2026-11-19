// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 §11.4: a model step's consumption waits on its pending costs the way a canvas generation does
 * (`cost-wait.ts`): looked up after `cost_wait_delay_ms`, then after twice the last wait, `cost_wait_attempts` times,
 * the last with `lastAttempt`; each answer is written back on the consumption, which is known once every handle has
 * an answer. The settlement claims the item that is due first and never one that is not due.
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, getNodeTaskConfig, initCore } from "@breatic/core";
import {
  claimMiniToolSettlement, endMiniToolModelStep, markStepSending, recordMiniToolConsumptionLookup, runMiniToolSettlement,
  type MiniToolSettlementLookup,
} from "@domain/index.js";

const DEADLINE = 4070908800000;
const lookupOf = (id: string): { upstream: string; predictionId: string } => ({ upstream: "wavespeed", predictionId: id });
let pg: ReturnType<typeof createPgClient>;

interface Fixture { taskId: string; stepIds: string[] }
interface Settlement { version: number; nextAttemptAt: string | null }
interface Waiting { state: string; known: number; attempts: number; nextLookupAt: number; waiting: { lookup: unknown; cost?: unknown }[] }

beforeAll(() => {
  initCore({ ...process.env, CREDIT_MULTIPLIER: "1", PAYMENT_ENABLED: "false" });
  pg = createPgClient(inject("DATABASE_URL"), { name: "consumption-lookup", max: 3 });
});
afterAll(async () => { await pg.end(); });

/**
 * Seed a running execution whose model steps each ended with one pending cost.
 * @param steps - How many steps.
 * @returns The task and its steps.
 * @throws {Error} When fixture SQL fails.
 */
async function seed(steps = 1): Promise<Fixture> {
  const taskId = crypto.randomUUID(); const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID(); const projectId = crypto.randomUUID();
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${userId},${`lookup-${userId}@example.test`},true)`;
  await pg`INSERT INTO studios (id,created_by_user_id,slug,type,name) VALUES (${studioId},${userId},${`s-${studioId}`},'team','Lookup')`;
  await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${projectId},${studioId},${userId},${`p-${projectId}`},'Lookup')`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result)
    VALUES (${taskId},${userId},${projectId},${crypto.randomUUID()},'mini_tool_execution','append','mini_tool','running',
      ${pg.json({ deadlineAt: DEADLINE })},${pg.json({})})`;
  const stepIds: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const stepId = crypto.randomUUID(); stepIds.push(stepId);
    await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output)
      VALUES (${stepId},${taskId},${i},'generate','bria-video-eraser-mask','pending',${pg.json({})})`;
    await markStepSending(taskId, stepId, DEADLINE);
    await endMiniToolModelStep({ taskId, stepId, end: { kind: "returned", link: `https://out.example/${i}.mp4` },
      costs: [{ state: "pending", lookup: lookupOf(`p-${i}`) }], servedBy: "wavespeed" });
  }
  return { taskId, stepIds };
}

/**
 * The consumption a step holds.
 * @param stepId - The step.
 * @returns Its waiting record.
 * @throws {Error} When the row is gone.
 */
async function consumptionOf(stepId: string): Promise<Waiting> {
  const [row] = await pg<{ output: { miniToolConsumption: Waiting } }[]>`SELECT output FROM task_upstream_steps WHERE id=${stepId}`;
  if (!row) throw new Error("Step fixture disappeared");
  return row.output.miniToolConsumption;
}

/**
 * The task's settlement.
 * @param f - The fixture.
 * @returns It.
 * @throws {Error} When the row is gone.
 */
async function settlementOf(f: Fixture): Promise<Settlement> {
  const [row] = await pg<{ result: { settlement: Settlement } }[]>`SELECT result FROM tasks WHERE id=${f.taskId}`;
  if (!row) throw new Error("Task fixture disappeared");
  return row.result.settlement;
}

/**
 * Move a step's next lookup.
 * @param stepId - The step.
 * @param at - Epoch milliseconds.
 */
async function dueAt(stepId: string, at: number): Promise<void> {
  await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolConsumption,nextLookupAt}',${pg.json(at)}) WHERE id=${stepId}`;
}

/**
 * Make the settlement due now.
 * @param f - The fixture.
 */
async function makeDue(f: Fixture): Promise<void> {
  await pg`UPDATE tasks SET result=jsonb_set(result,'{settlement,nextAttemptAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) WHERE id=${f.taskId}`;
}

/**
 * Make the settlement due now and claim it.
 * @param f - The fixture.
 * @returns The claim.
 * @throws {Error} When it is not claimed.
 */
async function claim(f: Fixture): Promise<NonNullable<Awaited<ReturnType<typeof claimMiniToolSettlement>>>> {
  await makeDue(f);
  const claimed = await claimMiniToolSettlement({ taskId: f.taskId, settlementVersion: (await settlementOf(f)).version });
  if (!claimed) throw new Error("Settlement was not claimed");
  return claimed;
}

describe("a model step's consumption wait", () => {
  it("is first due cost_wait_delay_ms after the step ended", async () => {
    const before = Date.now();
    const f = await seed();
    const held = await consumptionOf(f.stepIds[0]!);
    expect(held).toMatchObject({ state: "pending", attempts: 0, waiting: [{ lookup: lookupOf("p-0") }] });
    expect(held.nextLookupAt).toBeGreaterThanOrEqual(before + getNodeTaskConfig().cost_wait_delay_ms - 1000);
  });

  it("writes back a pending answer, counts it and waits twice as long", async () => {
    const f = await seed();
    await dueAt(f.stepIds[0]!, Date.now() - 1000);
    const owned = await claim(f);
    const before = Date.now();
    await recordMiniToolConsumptionLookup({ taskId: f.taskId, stepId: f.stepIds[0]!, claim: owned.claim, costs: [{ state: "pending", lookup: lookupOf("p-0") }] });
    const held = await consumptionOf(f.stepIds[0]!);
    expect(held).toMatchObject({ state: "pending", attempts: 1 });
    expect(held.nextLookupAt).toBeGreaterThanOrEqual(before + 2 * getNodeTaskConfig().cost_wait_delay_ms - 1000);
  });

  it("turns known once every handle has an answer, a missing cost counting nothing", async () => {
    const f = await seed();
    await dueAt(f.stepIds[0]!, Date.now() - 1000);
    const owned = await claim(f);
    await recordMiniToolConsumptionLookup({ taskId: f.taskId, stepId: f.stepIds[0]!, claim: owned.claim, costs: [{ state: "known", usd: 0.4, source: "billing" }] });
    expect(await consumptionOf(f.stepIds[0]!)).toMatchObject({ state: "known", known: 0.4, waiting: [{ cost: { state: "known", usd: 0.4 } }] });
    const g = await seed();
    await dueAt(g.stepIds[0]!, Date.now() - 1000);
    const other = await claim(g);
    await recordMiniToolConsumptionLookup({ taskId: g.taskId, stepId: g.stepIds[0]!, claim: other.claim, costs: [{ state: "missing", reason: "not billed" }] });
    expect(await consumptionOf(g.stepIds[0]!)).toMatchObject({ state: "known", known: 0 });
  });

  it("is refused under a lease that is no longer current", async () => {
    const f = await seed();
    await dueAt(f.stepIds[0]!, Date.now() - 1000);
    const owned = await claim(f);
    await expect(recordMiniToolConsumptionLookup({ taskId: f.taskId, stepId: f.stepIds[0]!, claim: { ...owned.claim, leaseToken: "stale" }, costs: [{ state: "known", usd: 1, source: "billing" }] })).rejects.toThrow();
    expect(await consumptionOf(f.stepIds[0]!)).toMatchObject({ state: "pending", attempts: 0 });
  });
});

describe("claiming a settlement with several waiting steps", () => {
  it("takes the step due first and skips one not yet due", async () => {
    const f = await seed(2);
    const now = Date.now();
    await dueAt(f.stepIds[0]!, now + 3_600_000);
    await dueAt(f.stepIds[1]!, now - 1000);
    expect((await claim(f)).nextConsumption?.stepId).toBe(f.stepIds[1]);
  });

  it("wakes at the earliest due step once the lookup is written back", async () => {
    const f = await seed(2);
    const now = Date.now();
    await dueAt(f.stepIds[0]!, now + 3_600_000);
    await dueAt(f.stepIds[1]!, now - 1000);
    const owned = await claim(f);
    await recordMiniToolConsumptionLookup({ taskId: f.taskId, stepId: f.stepIds[1]!, claim: owned.claim, costs: [{ state: "pending", lookup: lookupOf("p-1") }] });
    const next = Date.parse((await settlementOf(f)).nextAttemptAt!);
    const second = (await consumptionOf(f.stepIds[1]!)).nextLookupAt;
    expect(next).toBe(Math.min(second, now + 3_600_000));
  });
});

describe("running a settlement lookup", () => {
  it("asks with lastAttempt on the configured last lookup", async () => {
    const f = await seed();
    await pg`UPDATE task_upstream_steps SET output=jsonb_set(output,'{miniToolConsumption,attempts}',${pg.json(getNodeTaskConfig().cost_wait_attempts - 1)}) WHERE id=${f.stepIds[0]!}`;
    await dueAt(f.stepIds[0]!, Date.now() - 1000);
    const asked: boolean[] = [];
    const lookup: MiniToolSettlementLookup = (input) => {
      asked.push(input.lastAttempt === true);
      return Promise.resolve({ state: "looked_up", costs: [{ state: "missing", reason: "never billed" }] });
    };
    await makeDue(f);
    await runMiniToolSettlement({ taskId: f.taskId, settlementVersion: (await settlementOf(f)).version }, lookup);
    expect(asked).toEqual([true]);
    expect(await consumptionOf(f.stepIds[0]!)).toMatchObject({ state: "recorded", known: 0 });
  });
});
