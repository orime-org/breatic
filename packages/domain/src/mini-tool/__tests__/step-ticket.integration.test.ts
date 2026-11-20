// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 §11.2 and §11.4: each model step of a video mini-tool keeps its own provider ticket on its
 * `task_upstream_steps` row, and ends once, writing its result, its costs and its consumption in one transaction.
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore } from "@breatic/core";
import { DeadlinePassed } from "@breatic/shared";
import {
  getStepTicket, storeStepTicket, markStepSending, clearStepSending, appendMiniToolStepDeliveredCosts, endMiniToolModelStep,
  listUnresolvedMiniToolModelSteps,
} from "@domain/index.js";

const DEADLINE = 4070908800000;
const KNOWN = { state: "known" as const, usd: 0.25, source: "billing" as const };
const PENDING = { state: "pending" as const, lookup: { upstream: "wavespeed", predictionId: "p-1" } };
let pg: ReturnType<typeof createPgClient>;

interface Fixture { taskId: string; stepId: string }
interface StepRow { status: string; output: Record<string, unknown> }

beforeAll(() => {
  initCore({ ...process.env, CREDIT_MULTIPLIER: "1", PAYMENT_ENABLED: "false" });
  pg = createPgClient(inject("DATABASE_URL"), { name: "step-ticket", max: 3 });
});
afterAll(async () => { await pg.end(); });

/**
 * Seed a running execution with one pending model step, by SQL, without the code under test.
 * @param billed - Whether the task is billed already.
 * @returns The task and its step.
 * @throws {Error} When fixture SQL fails.
 */
async function seed(billed = false): Promise<Fixture> {
  const taskId = crypto.randomUUID(); const stepId = crypto.randomUUID(); const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID(); const projectId = crypto.randomUUID();
  await pg`INSERT INTO users (id,email,email_verified) VALUES (${userId},${`ticket-${userId}@example.test`},true)`;
  await pg`INSERT INTO studios (id,created_by_user_id,slug,type,name) VALUES (${studioId},${userId},${`s-${studioId}`},'team','Ticket')`;
  await pg`INSERT INTO projects (id,studio_id,created_by_user_id,slug,name) VALUES (${projectId},${studioId},${userId},${`p-${projectId}`},'Ticket')`;
  await pg`INSERT INTO tasks (id,user_id,project_id,space_id,task_type,mode,source,status,params,result,billed_at)
    VALUES (${taskId},${userId},${projectId},${crypto.randomUUID()},'mini_tool_execution','append','mini_tool','running',
      ${pg.json({ deadlineAt: DEADLINE })},${pg.json({})},${billed ? new Date() : null})`;
  await pg`INSERT INTO task_upstream_steps (id,task_id,position,kind,endpoint,status,output)
    VALUES (${stepId},${taskId},0,'generate','bria-video-eraser-mask','pending',${pg.json({})})`;
  return { taskId, stepId };
}

/**
 * Read the step row.
 * @param f - The fixture.
 * @returns Its status and output.
 * @throws {Error} When the row is gone.
 */
async function stepRow(f: Fixture): Promise<StepRow> {
  const [row] = await pg<StepRow[]>`SELECT status,output FROM task_upstream_steps WHERE id=${f.stepId}`;
  if (!row) throw new Error("Step fixture disappeared");
  return row;
}

describe("a model step's ticket", () => {
  it("is empty before the step's first plan", async () => {
    const f = await seed();
    expect(await getStepTicket(f.taskId, f.stepId)).toEqual({ ticket: null, sendingAt: null });
  });

  it("is stored only over an older version, and read back as stored", async () => {
    const f = await seed();
    expect(await storeStepTicket(f.taskId, f.stepId, { version: 1, phase: "send" })).toBe(true);
    expect(await storeStepTicket(f.taskId, f.stepId, { version: 1, phase: "other" })).toBe(false);
    expect(await storeStepTicket(f.taskId, f.stepId, { version: 0, phase: "older" })).toBe(false);
    expect(await storeStepTicket(f.taskId, f.stepId, { version: 2, phase: "running" })).toBe(true);
    expect((await getStepTicket(f.taskId, f.stepId)).ticket).toEqual({ version: 2, phase: "running" });
  });

  it("records the upstream a step is sent to, which its unresolved listing gives back", async () => {
    const f = await seed();
    await storeStepTicket(f.taskId, f.stepId, { version: 1 });
    await markStepSending(f.taskId, f.stepId, DEADLINE, "frozen-upstream");
    expect(await listUnresolvedMiniToolModelSteps(f.taskId)).toEqual([{ stepId: f.stepId, ticket: { version: 1 }, upstream: "frozen-upstream" }]);
  });

  it("carries a send mark between marking and clearing", async () => {
    const f = await seed();
    await markStepSending(f.taskId, f.stepId, DEADLINE, "wavespeed");
    expect((await getStepTicket(f.taskId, f.stepId)).sendingAt).toBeInstanceOf(Date);
    await clearStepSending(f.taskId, f.stepId);
    expect((await getStepTicket(f.taskId, f.stepId)).sendingAt).toBeNull();
  });

  it("refuses a step of another task", async () => {
    const f = await seed(); const other = await seed();
    await expect(storeStepTicket(other.taskId, f.stepId, { version: 1 })).rejects.toThrow();
    await expect(markStepSending(other.taskId, f.stepId, DEADLINE, "wavespeed")).rejects.toThrow();
    await expect(getStepTicket(other.taskId, f.stepId)).rejects.toThrow();
  });
});

describe("marking a model step's send", () => {
  it("opens the task's settlement on the first send and opens no consumption", async () => {
    const f = await seed();
    await markStepSending(f.taskId, f.stepId, DEADLINE, "wavespeed");
    const [task] = await pg<{ result: { settlement?: { state: string } } }[]>`SELECT result FROM tasks WHERE id=${f.taskId}`;
    expect(task?.result.settlement?.state).toBe("waiting");
    expect((await stepRow(f)).output.miniToolConsumption).toBeUndefined();
  });

  it("refuses a send once the task is billed", async () => {
    const f = await seed(true);
    await expect(markStepSending(f.taskId, f.stepId, DEADLINE, "wavespeed")).rejects.toThrow();
    expect((await getStepTicket(f.taskId, f.stepId)).sendingAt).toBeNull();
  });

  it("refuses a send once the task's consumption set is complete", async () => {
    const f = await seed();
    await pg`UPDATE tasks SET result=${pg.json({ settlement: { version: 1, state: "waiting", consumptionSetComplete: true, pendingConsumptionKeys: [], nextAttemptAt: null, leaseToken: null, leaseUntil: null, lastError: null } })} WHERE id=${f.taskId}`;
    await expect(markStepSending(f.taskId, f.stepId, DEADLINE, "wavespeed")).rejects.toThrow();
  });

  it("refuses a send past the deadline by the database clock", async () => {
    const f = await seed();
    await expect(markStepSending(f.taskId, f.stepId, Date.now() - 1000, "wavespeed")).rejects.toBeInstanceOf(DeadlinePassed);
    expect((await getStepTicket(f.taskId, f.stepId)).sendingAt).toBeNull();
  });
});

describe("ending a model step", () => {
  it("writes a returned step with its link, its costs and a known consumption, and clears the send mark", async () => {
    const f = await seed();
    await markStepSending(f.taskId, f.stepId, DEADLINE, "wavespeed");
    await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "returned", link: "https://out.example/a.mp4" }, costs: [KNOWN], servedBy: "wavespeed" });
    const row = await stepRow(f);
    expect(row.status).toBe("submitted");
    expect(row.output.providerReturn).toEqual({ link: "https://out.example/a.mp4" });
    expect(row.output.miniToolConsumption).toMatchObject({ identity: { kind: "provider", stepId: f.stepId }, state: "known", servedBy: "wavespeed", known: 0.25, waiting: [] });
    expect((await getStepTicket(f.taskId, f.stepId)).sendingAt).toBeNull();
  });

  it("writes a failed step whose pending cost opens a pending consumption with its lookup", async () => {
    const f = await seed();
    await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "failed", category: "model_rejected", error: { code: "model_rejected" } }, costs: [KNOWN, PENDING], servedBy: "wavespeed" });
    const row = await stepRow(f);
    expect(row.status).toBe("failed");
    expect(row.output.miniToolConsumption).toMatchObject({ state: "pending", known: 0.25, attempts: 0, waiting: [{ lookup: PENDING.lookup }] });
  });

  it("writes a known zero consumption for a step that cost nothing", async () => {
    const f = await seed();
    await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "failed", category: "timeout", error: { code: "timeout" } }, costs: [], servedBy: null });
    expect((await stepRow(f)).output.miniToolConsumption).toMatchObject({ state: "known", known: 0, waiting: [] });
  });

  it("adds the costs delivered before the end, once", async () => {
    const f = await seed();
    await appendMiniToolStepDeliveredCosts(f.taskId, f.stepId, [KNOWN]);
    await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "returned", link: "https://out.example/a.mp4" }, costs: [KNOWN], servedBy: "wavespeed" });
    expect((await stepRow(f)).output.miniToolConsumption).toMatchObject({ known: 0.5 });
  });

  it("keeps the first end of a step", async () => {
    const f = await seed();
    await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "returned", link: "https://out.example/a.mp4" }, costs: [KNOWN], servedBy: "wavespeed" });
    await endMiniToolModelStep({ taskId: f.taskId, stepId: f.stepId, end: { kind: "failed", category: "failed", error: { code: "failed" } }, costs: [KNOWN], servedBy: "wavespeed" });
    const row = await stepRow(f);
    expect(row.output.providerReturn).toBeDefined();
    expect(row.output.miniToolConsumption).toMatchObject({ known: 0.25 });
  });
});
