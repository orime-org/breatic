// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Credit admission order of the rowed runs and the 3D generation (inner#1968,
 * test spec H-38 to H-44, invariant L5 and the PT-5 extension; design 3.10 U9).
 *
 * Understanding, transcription and a server mini-tool hold their estimate
 * under the id the task row will take, then write that row, then open the
 * result nodes' rows, then queue the job. Every way out after the hold either
 * hands the run to the worker (task `pending`, a queued job, exactly one
 * `held` hold) or settles it in the same exit (no `held` hold, the task absent
 * or `failed`, no `running` node row).
 *
 * Real Postgres, Redis and BullMQ through the real Hono app, payments on. The
 * three failures the spec injects are wrappers that delegate to the real
 * code until a case arms them: writing the task row (`admitGeneration`),
 * opening a node row (`nodeTaskService.open`, `sceneTaskService.openGeneration`)
 * and queueing (`Queue.prototype.add` on the `tasks` queue). No worker runs,
 * so a queued job stays waiting.
 */

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

// What a case arms; every wrapper delegates to the real code otherwise.
const knobs = vi.hoisted(() => ({ failCreate: false, failOpenAt: 0, openCalls: 0, failScene: false, failEnqueue: false }));

vi.mock("@breatic/domain", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  const nodeTasks = actual.nodeTaskService as Record<string, unknown> & { open: (...args: unknown[]) => Promise<unknown> };
  const sceneTasks = actual.sceneTaskService as Record<string, unknown> & { openGeneration: (...args: unknown[]) => Promise<unknown> };
  return {
    ...actual,
    nodeTaskService: {
      ...nodeTasks,
      open: (...args: unknown[]) => {
        knobs.openCalls += 1;
        if (knobs.openCalls === knobs.failOpenAt) return Promise.reject(new Error("opening the node row failed"));
        return nodeTasks.open(...args);
      },
    },
    sceneTaskService: {
      ...sceneTasks,
      openGeneration: (...args: unknown[]) =>
        knobs.failScene ? Promise.reject(new Error("opening the Space row failed")) : sceneTasks.openGeneration(...args),
    },
  };
});

vi.mock("@server/modules/task/admit-generation.service.js", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  const real = actual.admitGeneration as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    admitGeneration: (...args: unknown[]) => (knobs.failCreate ? Promise.reject(new Error("writing the task row failed")) : real(...args)),
  };
});

import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { Queue } from "bullmq";
import type { Hono } from "hono";
import { createQueue, env, getStreamRedis, initCore, loadLocales, taskEventsStreamKey, type Redis } from "@breatic/core";
import { formatCredits, t } from "@breatic/shared";
import { admitGeneration } from "@server/modules/task/admit-generation.service.js";
import { holdRowedRun, startRowedRun } from "@server/modules/task/generation-task.js";
import { tasksQueue } from "@server/modules/task/tasks-queue.js";
import { PAYMENTS_ON, dbNow, request, seedAccount, seedMember, type Account, type Actor } from "./paid-account-fixtures.js";

let sql: ReturnType<typeof postgres>;
let app: Hono;
let queue: ReturnType<typeof createQueue>;
let subscriber: Redis;
/** Every Space task-list signal seen, as text. */
const spaceTaskSignals: string[] = [];
/** Jobs the `tasks` queue accepted, by task id. */
const queued = new Map<string, { projectId: string; jobId: string | undefined }>();
/** What each entry's estimate came to on an unrefused run. */
const estimates = new Map<Entry, number>();

beforeAll(async () => {
  initCore(PAYMENTS_ON);
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "credit-admission-order-test" } });
  app = (await import("@server/app.js")).createApp();
  queue = createQueue("tasks");
  subscriber = getStreamRedis().duplicate();
  subscriber.on("pmessage", (_pattern: string, _channel: string, message: string) => {
    spaceTaskSignals.push(message);
  });
  await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
  const original = Queue.prototype.add;
  vi.spyOn(Queue.prototype, "add").mockImplementation(async function (this: Queue, ...args: Parameters<Queue["add"]>) {
    const data = args[1] as { taskId?: string; projectId?: string };
    if (this.name === "tasks" && knobs.failEnqueue) throw new Error("the queue's Redis is unreachable");
    const job = await original.apply(this, args);
    if (this.name === "tasks" && data.taskId !== undefined) queued.set(data.taskId, { projectId: data.projectId ?? "", jobId: job.id });
    return job;
  });
  for (const entry of ENTRIES) estimates.set(entry, await measure(entry));
});

beforeEach(() => {
  Object.assign(knobs, { failCreate: false, failOpenAt: 0, openCalls: 0, failScene: false, failEnqueue: false });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await subscriber?.quit();
  await queue?.close();
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/** The rowed entries, the two-node mini-tool and the 3D generation. */
const ENTRIES = ["understand", "transcribe", "mini-tool", "mini-tool-2", "three-d", "generate"] as const;
type Entry = (typeof ENTRIES)[number];
/** The three rowed entries the spec names, each with one result node. */
const ROWED: readonly Entry[] = ["understand", "transcribe", "mini-tool"];

/** The settings a text-to-3D submission states. */
const TEXT_SETTINGS = {
  texture: true,
  pbr: false,
  texture_quality: "detailed",
  texture_version: "v3.0",
  delight: true,
  geometry_quality: "standard",
  smart_low_poly: false,
  generate_parts: false,
  face_limit: 10_000,
  auto_size: false,
  export_uv: true,
  model_seed: 7,
};

/**
 * How many result nodes an entry writes to.
 * @param entry - The entry.
 * @returns Its node count.
 */
function nodeCount(entry: Entry): number {
  if (entry === "three-d") return 0;
  return entry === "mini-tool-2" ? 2 : 1;
}

/**
 * Submit one press of an entry.
 * @param a - Where.
 * @param who - Who presses.
 * @param entry - Which entry.
 * @param nodeIds - The result nodes the browser built.
 * @returns The answer.
 */
function press(a: Account, who: Actor, entry: Entry, nodeIds: string[]): Promise<Response> {
  const at = { project_id: a.projectId, space_id: a.spaceId, node_ids: nodeIds };
  switch (entry) {
    case "understand":
      return request(app, who.cookie, "POST", "/canvas/understand", { ...at, source_type: "image", source_url: "https://assets.invalid/image/a.png" });
    case "transcribe":
      return request(app, who.cookie, "POST", "/canvas/transcribe", { ...at, source_type: "audio", source_url: "https://assets.invalid/audio/a.m4a", keep_fillers: true });
    case "mini-tool":
      return request(app, who.cookie, "POST", "/mini-tools", {
        ...at, tool: "image.upscale", source: { url: "https://assets.invalid/image/a.png" }, params: { target_megapixels: 16, creativity: 2 }, slots: {},
      });
    case "mini-tool-2":
      return request(app, who.cookie, "POST", "/mini-tools", { ...at, tool: "audio.separate", source: { url: "https://assets.invalid/audio/a.m4a" }, params: {}, slots: {} });
    case "generate":
      return request(app, who.cookie, "POST", "/canvas/tasks", {
        project_id: a.projectId, space_id: a.spaceId, source: "task", mode: "overwrite", target_node_id: nodeIds[0], task_type: "image", model: "flux-schnell", params: { prompt: "a cat" },
      });
    case "three-d":
      return request(app, who.cookie, "POST", `/projects/${a.projectId}/three-d/${a.spaceId}/generations`, {
        mode: "t23d", model: "tripo-h3.1-t23d", prompt: "a red barn lamp", params: { ...TEXT_SETTINGS, negative_prompt: "blurry" }, origin: "space",
      });
  }
}

/**
 * Fresh result node ids for an entry.
 * @param entry - The entry.
 * @returns As many ids as it writes to.
 */
function nodesFor(entry: Entry): string[] {
  return Array.from({ length: nodeCount(entry) }, () => crypto.randomUUID());
}

/**
 * What an entry's estimate comes to: the hold of one unrefused run.
 * @param entry - The entry.
 * @returns The held amount.
 */
async function measure(entry: Entry): Promise<number> {
  const a = await seedAccount(sql, { credits: 10_000 });
  const res = await press(a, a, entry, nodesFor(entry));
  expect(res.status, `${entry}: ${await res.clone().text()}`).toBe(201);
  const { task_id: taskId } = ((await res.json()) as { data: { task_id: string } }).data;
  const [row] = await sql<{ amount: string }[]>`select amount::text as amount from credit_holds where reference_id = ${taskId}`;
  const amount = Number(row!.amount);
  expect(amount, `${entry} must spend credits`).toBeGreaterThan(0);
  return amount;
}

/**
 * The refusal body of an answer.
 * @param res - The answer.
 * @returns Its `error`.
 */
async function refusal(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

/**
 * Another running task's hold on the studio.
 * @param a - Whose studio.
 * @param amount - How much it holds.
 * @returns Its reference.
 */
async function runningHold(a: Account, amount: number): Promise<string> {
  const reference = `running-${crypto.randomUUID()}`;
  await sql`insert into credit_holds(studio_id, actor_user_id, reference_id, amount, status, expires_at)
    values (${a.studioId}, ${a.userId}, ${reference}, ${amount}, 'held', ${new Date(Date.now() + 3_600_000)})`;
  return reference;
}

interface TaskRow {
  id: string;
  status: string;
  error_message: string | null;
  arq_job_id: string | null;
}

/**
 * The project's task rows.
 * @param a - Which project.
 * @returns Them.
 */
function taskRows(a: Account): Promise<TaskRow[]> {
  return sql<TaskRow[]>`select id, status, error_message, arq_job_id from tasks where project_id = ${a.projectId}`;
}

/**
 * The project's node rows, canvas and Space-level alike.
 * @param a - Which project.
 * @returns Them.
 */
function nodeRows(a: Account): Promise<{ id: string; node_id: string | null; task_id: string | null; status: string; error_message: string | null }[]> {
  return sql`select id, node_id, task_id, status, error_message from node_tasks where project_id = ${a.projectId}`;
}

/**
 * Assert invariant L5 for every run of the project: each one is either handed
 * to the worker or settled, never both and never neither, and nothing outside
 * a handed run holds credits, runs a node row or sits in the queue.
 * @param a - Which project.
 * @param keep - Holds that predate the case and are not this project's runs.
 * @returns The ids handed to the worker and the ids settled.
 */
async function expectL5(a: Account, keep: readonly string[] = []): Promise<{ handed: string[]; settled: string[] }> {
  const handed: string[] = [];
  const settled: string[] = [];
  for (const task of await taskRows(a)) {
    const holds = await sql<{ status: string }[]>`select status from credit_holds where reference_id = ${task.id}`;
    const rows = await sql<{ status: string }[]>`select status from node_tasks where task_id = ${task.id}`;
    const job = task.arq_job_id ? await queue.getJob(task.arq_job_id) : undefined;
    const isHanded = task.status === "pending" && job != null && holds.length === 1 && holds[0]!.status === "held";
    const isSettled = task.status === "failed" && !holds.some((h) => h.status === "held") && !rows.some((r) => r.status === "running") && !queued.has(task.id);
    expect(isHanded !== isSettled, `L5 for task ${task.id}: ${JSON.stringify({ task, holds, rows, job: job?.id ?? null })}`).toBe(true);
    (isHanded ? handed : settled).push(task.id);
  }
  const held = await sql<{ reference_id: string }[]>`select reference_id from credit_holds where studio_id = ${a.studioId} and status = 'held'`;
  expect(held.map((h) => h.reference_id).filter((r) => !handed.includes(r) && !keep.includes(r))).toEqual([]);
  expect((await nodeRows(a)).filter((r) => r.status === "running" && !handed.includes(r.task_id ?? ""))).toEqual([]);
  expect([...queued].filter(([id, q]) => q.projectId === a.projectId && !handed.includes(id))).toEqual([]);
  return { handed, settled };
}

/**
 * Assert a refused admission left nothing: no task, no node row, no held hold
 * besides `keep`, no job.
 * @param a - Which project.
 * @param keep - Holds that predate the case.
 */
async function expectNothingLeft(a: Account, keep: readonly string[] = []): Promise<void> {
  expect(await taskRows(a)).toEqual([]);
  expect(await nodeRows(a)).toEqual([]);
  await expectL5(a, keep);
}

/**
 * The node events on the task-events stream that name a node.
 * @param nodeId - The node.
 * @returns Their payloads.
 */
async function nodeEvents(nodeId: string): Promise<string[]> {
  const entries = await getStreamRedis().xrevrange(taskEventsStreamKey(), "+", "-", "COUNT", 2000);
  return entries.map(([, fields]) => fields.join(" ")).filter((payload) => payload.includes(nodeId));
}

/**
 * Wait until the subscriber has seen a task-list signal for the Space.
 * @param spaceId - Which Space.
 * @returns The signals for it.
 */
async function spaceSignals(spaceId: string): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const mine = spaceTaskSignals.filter((m) => m.includes(spaceId));
    if (mine.length > 0 || Date.now() > deadline) return mine;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("H-38 to H-44 credit admission order (design 3.10 U9)", () => {
  it("H-38 a studio with no balance refuses each entry with 402 and leaves nothing", async () => {
    for (const entry of ROWED) {
      const a = await seedAccount(sql, { credits: 0 });
      const y = await seedMember(sql, a);
      const res = await press(a, y, entry, nodesFor(entry));
      expect(res.status, entry).toBe(402);
      const error = await refusal(res);
      expect(error.reason, entry).not.toBe("spend_cap_reached");
      expect(error.message, entry).toBe(t("server.credit.none"));
      await expectNothingLeft(a);
    }
  });

  it("H-39 a balance that running work holds refuses each entry with the held sentence, and leaves that hold alone", async () => {
    for (const entry of ROWED) {
      const e = estimates.get(entry)!;
      const h = 0.01;
      const a = await seedAccount(sql, { credits: e });
      const y = await seedMember(sql, a);
      const other = await runningHold(a, h);
      const res = await press(a, y, entry, nodesFor(entry));
      expect(res.status, entry).toBe(402);
      const error = await refusal(res);
      expect(error.reason, entry).toBeUndefined();
      expect(error.message, entry).toBe(t("server.credit.held_by_running", { held: formatCredits(h, "en"), available: formatCredits(e - h, "en") }));
      await expectNothingLeft(a, [other]);
      const [kept] = await sql<{ status: string; amount: string }[]>`select status, amount::text as amount from credit_holds where reference_id = ${other}`;
      expect(kept).toEqual({ status: "held", amount: expect.any(String) });
      expect(Number(kept!.amount)).toBe(h);
    }
  });

  it("H-40 writing the task row failing after the hold releases it, and nothing is left", async () => {
    for (const entry of ROWED) {
      const a = await seedAccount(sql);
      knobs.failCreate = true;
      const res = await press(a, a, entry, nodesFor(entry));
      knobs.failCreate = false;
      expect(res.status, entry).toBe(500);
      const holds = await sql<{ status: string }[]>`select status from credit_holds where studio_id = ${a.studioId}`;
      expect(holds.length, `${entry}: the hold was taken before the row`).toBe(1);
      await expectNothingLeft(a);
    }
  });

  it("H-41 opening the one node row failing answers 503, fails the task as internal and releases the hold", async () => {
    for (const entry of ROWED) {
      const a = await seedAccount(sql);
      Object.assign(knobs, { openCalls: 0, failOpenAt: 1 });
      const res = await press(a, a, entry, nodesFor(entry));
      knobs.failOpenAt = 0;
      expect(res.status, entry).toBe(503);
      expect((await refusal(res)).message, entry).toBe(t("canvas.task.couldNotStart"));
      const tasks = await taskRows(a);
      expect(tasks, entry).toEqual([expect.objectContaining({ status: "failed", error_message: "internal" })]);
      expect((await expectL5(a)).settled, entry).toEqual([tasks[0]!.id]);
    }
  });

  it("H-41 opening the second of two node rows failing settles the first row too (5.3 #34)", async () => {
    const a = await seedAccount(sql);
    const nodes = nodesFor("mini-tool-2");
    Object.assign(knobs, { openCalls: 0, failOpenAt: 2 });
    const res = await press(a, a, "mini-tool-2", nodes);
    knobs.failOpenAt = 0;
    expect(res.status).toBe(503);
    expect((await refusal(res)).message).toBe(t("canvas.task.couldNotStart"));
    const tasks = await taskRows(a);
    expect(tasks).toEqual([expect.objectContaining({ status: "failed", error_message: "internal" })]);
    const rows = await nodeRows(a);
    expect(rows.map((r) => r.node_id)).toEqual([nodes[0]]);
    expect(rows[0]!.status).not.toBe("running");
    expect((await expectL5(a)).settled).toEqual([tasks[0]!.id]);
  });

  it("H-41 opening the 3D Space row failing answers with its own error, fails the task as internal and releases the hold", async () => {
    const a = await seedAccount(sql);
    knobs.failScene = true;
    const res = await press(a, a, "three-d", []);
    knobs.failScene = false;
    expect(res.status).toBe(500);
    const tasks = await taskRows(a);
    expect(tasks).toEqual([expect.objectContaining({ status: "failed", error_message: "internal" })]);
    expect(await nodeRows(a)).toEqual([]);
    expect((await expectL5(a)).settled).toEqual([tasks[0]!.id]);
  });

  it("H-42 queueing failing answers 201 failed, fails the task and every node row as internal, signals the counts and releases the hold", async () => {
    for (const entry of [...ROWED, "mini-tool-2"] as Entry[]) {
      const a = await seedAccount(sql);
      const nodes = nodesFor(entry);
      knobs.failEnqueue = true;
      const res = await press(a, a, entry, nodes);
      knobs.failEnqueue = false;
      expect(res.status, entry).toBe(201);
      const { task_id: taskId, status } = ((await res.json()) as { data: { task_id: string; status: string } }).data;
      expect(status, entry).toBe("failed");
      expect(await taskRows(a), entry).toEqual([expect.objectContaining({ id: taskId, status: "failed", error_message: "internal" })]);
      const rows = await nodeRows(a);
      expect(rows.map((r) => r.node_id).sort(), entry).toEqual([...nodes].sort());
      for (const row of rows) expect(row, entry).toMatchObject({ status: "failed", error_message: "internal" });
      // One counts event when the row opened, one when it settled failed.
      for (const node of nodes) expect((await nodeEvents(node)).length, `${entry}: counts of ${node}`).toBeGreaterThanOrEqual(2);
      expect((await expectL5(a)).settled, entry).toEqual([taskId]);
    }
  });

  it("H-42 queueing a 3D generation failing answers 201 failed, ends its row as internal, signals the Space and releases the hold", async () => {
    const a = await seedAccount(sql);
    knobs.failEnqueue = true;
    const res = await press(a, a, "three-d", []);
    knobs.failEnqueue = false;
    expect(res.status).toBe(201);
    const { task_id: taskId, status } = ((await res.json()) as { data: { task_id: string; status: string } }).data;
    expect(status).toBe("failed");
    expect(await taskRows(a)).toEqual([expect.objectContaining({ id: taskId, status: "failed", error_message: "internal" })]);
    expect(await nodeRows(a)).toEqual([expect.objectContaining({ task_id: taskId, status: "failed", error_message: "internal" })]);
    expect((await spaceSignals(a.spaceId)).length).toBeGreaterThanOrEqual(1);
    expect((await expectL5(a)).settled).toEqual([taskId]);
  });

  it("H-43 a member past the default cap is refused a 3D generation with the member scope and nothing is listed", async () => {
    const a = await seedAccount(sql);
    const y = await seedMember(sql, a);
    const e = estimates.get("three-d")!;
    const cap = Math.max(10, Math.ceil(e));
    const spent = Math.round((cap - e + 0.01) * 100) / 100;
    await sql`insert into studio_spend_limits(studio_id, member_default_credits, studio_monthly_credits, updated_by_user_id) values (${a.studioId}, ${cap}, null, ${a.userId})`;
    await sql`insert into credit_charge_requests(kind, actor_user_id, reference_id, project_id, studio_id, amount, status, settled_at)
      values ('task', ${y.userId}, ${`spent-${crypto.randomUUID()}`}, ${a.projectId}, ${a.studioId}, ${spent}, 'settled', now())`;
    const listPath = `/projects/${a.projectId}/three-d/${a.spaceId}/tasks`;
    const listed = async (): Promise<unknown> => ((await (await request(app, y.cookie, "GET", listPath, undefined)).json()) as { data: { tasks: unknown } }).data.tasks;
    const before = await listed();
    const res = await press(a, y, "three-d", []);
    expect(res.status).toBe(402);
    const now = await dbNow(sql);
    const error = await refusal(res);
    expect(error).toMatchObject({ reason: "spend_cap_reached", scope: "member" });
    expect(Number(error.limit)).toBe(cap);
    expect(new Date(String(error.resetsAt)).toISOString()).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());
    await expectNothingLeft(a);
    expect(await listed()).toEqual(before);
  });

  it("H-44 holdRowedRun then startRowedRun with no credits of its own answers pending with exactly one held hold of the estimate", async () => {
    const a = await seedAccount(sql);
    const taskId = crypto.randomUUID();
    const nodeId = crypto.randomUUID();
    const params = { prompt: "a cat" };
    const task = await holdRowedRun({
      taskId,
      projectId: a.projectId,
      userId: a.userId,
      credits: () => Promise.resolve(1.5),
      create: () => admitGeneration(a.userId, a.projectId, a.spaceId, "image", "append", params, "flux-schnell", "task", taskId),
    });
    const status = await startRowedRun({
      taskId: task.id,
      projectId: a.projectId,
      spaceId: a.spaceId,
      nodeIds: [nodeId],
      userId: a.userId,
      action: "generate",
      label: "flux-schnell",
      enqueue: () => tasksQueue().add("execute-task", { taskId: task.id, userId: a.userId, projectId: a.projectId, spaceId: a.spaceId, taskType: "image", model: "flux-schnell", params, source: "task", targetNodeIds: [nodeId], mode: "append" }),
      logTag: "h44",
    });
    expect(status).toBe("pending");
    const holds = await sql<{ status: string; amount: string }[]>`select status, amount::text as amount from credit_holds where reference_id = ${taskId}`;
    expect(holds).toHaveLength(1);
    expect(holds[0]!.status).toBe("held");
    expect(Number(holds[0]!.amount)).toBe(1.5);
    expect((await expectL5(a)).handed).toEqual([taskId]);
  });

  it("H-44 each entry submitted normally answers 201 pending with one held hold, running node rows and a queued job", async () => {
    for (const entry of [...ROWED, "three-d"] as Entry[]) {
      const a = await seedAccount(sql);
      const res = await press(a, a, entry, nodesFor(entry));
      expect(res.status, `${entry}: ${await res.clone().text()}`).toBe(201);
      const { task_id: taskId, status } = ((await res.json()) as { data: { task_id: string; status: string } }).data;
      expect(status, entry).toBe("pending");
      const rows = await nodeRows(a);
      expect(rows.length, entry).toBe(Math.max(1, nodeCount(entry)));
      for (const row of rows) expect(row.status, entry).toBe("running");
      expect((await expectL5(a)).handed, entry).toEqual([taskId]);
    }
  });
});

describe("PT-5 extension: every admission exit keeps L5", () => {
  it("whatever the entry, balance, cap and injected failure, each run is handed to the worker or settled, and a refusal leaves nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENTRIES),
        fc.constantFrom("enough", "zero", "held-full"),
        fc.constantFrom<number | null>(null, null, 0),
        fc.constantFrom("none", "create", "open", "enqueue"),
        fc.boolean(),
        async (entry, balance, cap, failure, secondRow) => {
          const e = estimates.get(entry)!;
          const a = await seedAccount(sql, { credits: balance === "zero" ? 0 : balance === "held-full" ? e : 10_000 });
          const y = await seedMember(sql, a);
          const keep = balance === "held-full" ? [await runningHold(a, 0.01)] : [];
          if (cap !== null) await sql`insert into studio_spend_limits(studio_id, member_default_credits, studio_monthly_credits, updated_by_user_id) values (${a.studioId}, ${cap}, null, ${a.userId})`;
          Object.assign(knobs, {
            failCreate: failure === "create",
            failOpenAt: failure !== "open" ? 0 : entry === "mini-tool-2" && secondRow ? 2 : 1,
            openCalls: 0,
            failScene: failure === "open" && entry === "three-d",
            failEnqueue: failure === "enqueue",
          });
          let res: Response;
          try {
            res = await press(a, y, entry, nodesFor(entry));
          } finally {
            Object.assign(knobs, { failCreate: false, failOpenAt: 0, failScene: false, failEnqueue: false });
          }
          const tag = `${entry} ${balance} cap=${cap} ${failure}: ${await res.clone().text()}`;
          const { handed } = await expectL5(a, keep);
          if (res.status === 402) {
            expect(cap !== null || balance !== "enough", tag).toBe(true);
            expect(await taskRows(a), tag).toEqual([]);
            expect(await nodeRows(a), tag).toEqual([]);
            if (cap === 0) expect((await refusal(res)).reason, tag).toBe("spend_cap_reached");
          } else {
            expect(cap === null && balance === "enough", tag).toBe(true);
            if (failure === "none") expect(handed.length, tag).toBe(1);
            else expect(handed, tag).toEqual([]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
