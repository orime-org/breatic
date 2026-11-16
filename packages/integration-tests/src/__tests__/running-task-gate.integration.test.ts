// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How many tasks one person may run at once (inner#1968, test spec area G:
 * G-01 to G-21, G-23, G-24, G-30 to G-33; invariants K1 to K4; PT-4).
 *
 * The worker calls the domain gate `runningSlotService.startWithinLimit` for a
 * row nobody has taken yet (`tasks.status = 'pending'`, Timeline `queued`).
 * Under `pg_try_advisory_xact_lock(hashtext('running-tasks:' || user_id))` it
 * counts what the person runs (`R`: `tasks` running within
 * `default_budget_ms + REPORT_GRACE_MS` of their start, plus Timeline
 * `running`/`cancelling` within `REPORT_GRACE_MS` of their deadline) and the
 * earlier waiters under the same limit that were checked within
 * `slot_wait_stale_ms` (`W`). `R + W < L` starts the row; otherwise it waits:
 * the row keeps `pending`, `slot_wait_since` is written once, the node task row
 * gets `waiting_since`, and the gate throws `StillRunning` whose `resumeAt` is
 * `now + min(poll × max(1, W − (L − R) + 1), slot_wait_max_delay_ms)`. A lock
 * it cannot take writes nothing and resumes after one poll. `L` is the
 * `running_tasks_per_user` of the studio the task runs in: 2 on base, 10 on
 * team, 9999 self-hosted, the agreement's number on an enterprise and 10 for
 * an enterprise without one.
 *
 * Shapes this suite chose where the design names none: the gate takes
 * `{ table: "tasks" | "timeline_executions", id, jobId }` and resolves
 * `{ outcome: "started" }` or, for a row already ended, `{ outcome: "ended" }`;
 * waiting is the thrown error named `StillRunning` carrying `resumeAt` (epoch
 * ms). The stale-waiter sweep is `sweepSlotWaiters(queue)` in
 * `@worker/handlers/slot-wait-sweep.js`, with the same `getJob` queue shape as
 * the Timeline sweep.
 *
 * Not here: BullMQ's `attemptsMade` and `moveToDelayed` (the gate's caller in
 * `dispatch.ts`, driven only by a live job), the counts event on the stream,
 * and the web and collab parts. Real Postgres and Redis; nothing sleeps: time
 * is reached by writing time columns.
 */

import { initConfiguredProvider } from "@breatic/integration-tests/provider";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import postgres from "postgres";
import { getNodeTaskConfig, getStreamRedis, getWorkerConfig, initCore, initLogger, loadLocales, REPORT_GRACE_MS, timelineExecutionRepo } from "@breatic/core";
import { nodeTaskService, runningSlotService, taskService } from "@breatic/domain";
import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";
import { finishFailedRun } from "@worker/handlers/dispatch.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { sweepTimelineExecutions } from "@worker/handlers/timeline/timeline-sweep.js";

let sql: ReturnType<typeof postgres>;

/** `default_budget_ms`. */
let B: number;
/** The worker's `poll_interval`. */
const POLL = 3000;
/** `slot_wait_stale_ms`. */
const STALE = 120_000;
/** `slot_wait_max_delay_ms`. */
const MAX_DELAY = 30_000;

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  initConfiguredProvider();
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false, connection: { application_name: "running-task-gate-test" } });
  B = getNodeTaskConfig().default_budget_ms;
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** Someone who starts tasks, and where. */
interface Person {
  userId: string;
  studioId: string;
  projectId: string;
  spaceId: string;
}

/** How a person's studio sets the limit. */
type Tier = "base" | "team" | "self_hosted" | "enterprise" | "enterprise_missing";

/**
 * The database clock, to millisecond precision.
 * @returns The current statement time.
 */
async function dbNow(): Promise<Date> {
  const [row] = await sql<{ now: Date }[]>`select date_trunc('milliseconds', statement_timestamp()) as now`;
  return row!.now;
}

/**
 * A person with a personal studio and a project in it.
 * @param tier - Their tier; an enterprise carries `runningTasks` in its agreement.
 * @param runningTasks - The agreement's `running_tasks_per_user`.
 * @returns The ids.
 */
async function person(tier: Tier = "base", runningTasks = 10): Promise<Person> {
  const userId = crypto.randomUUID();
  const studioId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const stored = tier.startsWith("enterprise") ? "enterprise" : tier;
  await sql`insert into users(id, email, email_verified, membership_tier) values (${userId}, ${`${userId}@example.test`}, true, ${stored})`;
  if (tier === "enterprise") {
    await sql`insert into enterprise_memberships(user_id,expires_at,entry_timezone,contract_number,team_studios,projects_per_studio,concurrent_editors,studio_members,project_members,storage_bytes,fallback_tier,revision,monthly_operations,running_tasks_per_user)
      values(${userId}, now() + interval '30 days', 'UTC', 'TEST-ENT-1968', 8, 20, 30, 200, 80, 1099511627776, 'base', 1, 16000, ${runningTasks})`;
  }
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`g-${studioId}`}, 'personal', 'Gate')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`g-${projectId}`}, 'Gate')`;
  return { userId, studioId, projectId, spaceId: crypto.randomUUID() };
}

/** What a seeded task differs in. */
interface TaskSeed {
  status?: "pending" | "running" | "failed" | "completed" | "cancelled";
  startedAt?: Date | null;
  createdAt?: Date;
  /** Already waiting: `slot_wait_since`, `slot_checked_at` and `slot_wait_limit`. */
  waiting?: { since: Date; checkedAt: Date; limit: number };
  /** Open a running node task row for it. */
  node?: boolean;
  /** The node task row started then; now by default. */
  nodeStartedAt?: Date;
  /** The project; the person's own by default. */
  projectId?: string;
  jobId?: string | null;
}

/** A seeded task and its node row. */
interface Seeded {
  taskId: string;
  nodeId: string | null;
  nodeTaskId: string | null;
}

/**
 * Write a task row, and its node task row when asked.
 * @param p - Whose.
 * @param s - What differs from a fresh pending generation.
 * @returns Its ids.
 */
async function seedTask(p: Person, s: TaskSeed = {}): Promise<Seeded> {
  const taskId = crypto.randomUUID();
  const row: Record<string, unknown> = {
    id: taskId,
    user_id: p.userId,
    project_id: s.projectId ?? p.projectId,
    space_id: p.spaceId,
    task_type: "image",
    mode: "append",
    model: "flux-schnell",
    status: s.status ?? "pending",
    params: sql.json({}),
    arq_job_id: s.jobId === undefined ? `job-${taskId}` : s.jobId,
    started_at: s.startedAt ?? null,
    created_at: s.createdAt ?? new Date(),
  };
  if (s.waiting) {
    row.slot_wait_since = s.waiting.since;
    row.slot_checked_at = s.waiting.checkedAt;
    row.slot_wait_limit = s.waiting.limit;
  }
  await sql`insert into tasks ${sql(row)}`;
  if (!s.node) return { taskId, nodeId: null, nodeTaskId: null };
  const nodeId = crypto.randomUUID();
  const node: Record<string, unknown> = {
    project_id: s.projectId ?? p.projectId,
    space_id: p.spaceId,
    node_id: nodeId,
    kind: "generation",
    action: "generate",
    status: "running",
    started_by_user_id: p.userId,
    started_at: s.nodeStartedAt ?? new Date(),
    budget_ms: B,
    label: "flux-schnell",
    task_id: taskId,
  };
  if (s.waiting) node.waiting_since = s.waiting.since;
  const [inserted] = await sql<{ id: string }[]>`insert into node_tasks ${sql(node)} returning id`;
  return { taskId, nodeId, nodeTaskId: inserted!.id };
}

/**
 * Tasks the person already runs, started at the given instant.
 * @param p - Whose.
 * @param n - How many.
 * @param startedAt - Their start; now by default.
 */
async function running(p: Person, n: number, startedAt?: Date): Promise<void> {
  const at = startedAt ?? (await dbNow());
  await sql`insert into tasks(user_id, project_id, space_id, task_type, mode, model, status, params, started_at, created_at)
    select ${p.userId}, ${p.projectId}, ${p.spaceId}, 'image', 'append', 'flux-schnell', 'running', '{}'::jsonb, ${at}, ${at}
    from generate_series(1, ${n})`;
}

/** What one pickup came to. */
type Picked = { started: true } | { ended: true } | { waiting: true; resumeAt: number };

/**
 * One pickup of a row through the gate.
 * @param id - The row.
 * @param table - Its table.
 * @returns Started, ended, or waiting with when it comes back.
 */
async function pick(id: string, table: "tasks" | "timeline_executions" = "tasks"): Promise<Picked> {
  try {
    const out = (await runningSlotService.startWithinLimit({ table, id, jobId: `job-${id}` })) as { outcome: string };
    return out.outcome === "started" ? { started: true } : { ended: true };
  } catch (err) {
    if (err instanceof Error && err.name === "StillRunning") return { waiting: true, resumeAt: (err as Error & { resumeAt: number }).resumeAt };
    throw err;
  }
}

/** A task row as the cases read it. */
interface TaskRow {
  status: string;
  started_at: Date | null;
  error_message: string | null;
  slot_wait_since: Date | null;
  slot_checked_at: Date | null;
  slot_wait_limit: number | null;
}

/**
 * One task row.
 * @param id - The task.
 * @returns The row.
 */
async function taskRow(id: string): Promise<TaskRow> {
  const [row] = await sql<TaskRow[]>`select status, started_at, error_message, slot_wait_since, slot_checked_at, slot_wait_limit from tasks where id = ${id}`;
  return row!;
}

/** A node task row as the cases read it. */
interface NodeRow {
  status: string;
  started_at: Date;
  waiting_since: Date | null;
  error_message: string | null;
}

/**
 * One node task row.
 * @param id - The row.
 * @returns It.
 */
async function nodeRow(id: string): Promise<NodeRow> {
  const [row] = await sql<NodeRow[]>`select status, started_at, waiting_since, error_message from node_tasks where id = ${id}`;
  return row!;
}

/**
 * Assert that an instant falls between two database readings.
 * @param value - The instant.
 * @param before - Read before.
 * @param after - Read after.
 */
function between(value: Date | null | undefined, before: Date, after: Date): void {
  expect(value).toBeInstanceOf(Date);
  expect(value!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
  expect(value!.getTime()).toBeLessThanOrEqual(after.getTime() + 1);
}

/**
 * How many of the person's tasks run.
 * @param p - Whose.
 * @returns The count.
 */
async function runningCount(p: Person): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where user_id = ${p.userId} and status = 'running'`;
  return row!.n;
}

/**
 * The credit hold and the ledger row an admitted task holds, expiring at `expiresAt`.
 * @param p - Whose.
 * @param taskId - The task.
 * @param expiresAt - When both stop counting.
 */
async function inFlight(p: Person, taskId: string, expiresAt: Date): Promise<void> {
  const key = `task:${taskId}`;
  await sql`insert into credit_holds(studio_id, actor_user_id, reference_id, amount, status, expires_at) values (${p.studioId}, ${p.userId}, ${taskId}, 1, 'held', ${expiresAt})`;
  await sql`insert into credit_holds(studio_id, actor_user_id, reference_id, amount, status, expires_at) values (${p.studioId}, ${p.userId}, ${`operation:${key}`}, 0.5, 'held', ${expiresAt})`;
  await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, overage_hold, expires_at)
    values (${key}, 'generation', ${p.userId}, ${p.studioId}, ${p.projectId}, ${p.userId}, 'reserved', 'held', ${`operation:${key}`}, ${expiresAt})`;
}

/**
 * What an admitted task holds: its credit hold, its overage hold and its ledger row.
 * @param taskId - The task.
 * @returns Each one's status and expiry.
 */
async function holdings(taskId: string): Promise<{ credit: { status: string; expires_at: Date }; overage: { status: string; expires_at: Date }; ledger: { status: string; expires_at: Date } }> {
  const [credit] = await sql<{ status: string; expires_at: Date }[]>`select status, expires_at from credit_holds where reference_id = ${taskId}`;
  const [overage] = await sql<{ status: string; expires_at: Date }[]>`select status, expires_at from credit_holds where reference_id = ${`operation:task:${taskId}`}`;
  const [ledger] = await sql<{ status: string; expires_at: Date }[]>`select status, expires_at from operation_ledger where operation_key = ${`task:${taskId}`}`;
  return { credit: credit!, overage: overage!, ledger: ledger! };
}

/**
 * A Timeline execution of the person's, moved to the state the case starts from.
 * @param p - Whose.
 * @param state - Where it starts.
 * @param deadlineAt - Its deadline; two hours on by default.
 * @returns Its id.
 */
async function execution(p: Person, state: "awaiting_landing" | "queued" | "running" | "cancelling", deadlineAt = new Date(Date.now() + 2 * 3_600_000)): Promise<string> {
  const row = await timelineExecutionRepo.insert({
    projectId: p.projectId,
    spaceId: p.spaceId,
    actorUserId: p.userId,
    kind: "web_animation_create",
    engine: "deepseek",
    actionId: crypto.randomUUID(),
    input: { prompt: "A red square slides in", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } },
    inputHash: `sha256:${crypto.randomUUID()}`,
    deadlineAt,
  });
  if (row === null) throw new Error("fixture execution conflicted");
  const step = async (event: Parameters<typeof timelineExecutionRepo.transition>[0]["event"]): Promise<void> => {
    const result = await timelineExecutionRepo.transition({ id: row.id, event });
    if (!result.applied) throw new Error(`fixture step ${event.type} refused`);
  };
  if (state !== "awaiting_landing") await step({ type: "land", inputHash: row.inputHash });
  if (state === "running" || state === "cancelling") await step({ type: "claim" });
  if (state === "cancelling") await step({ type: "cancel" });
  return row.id;
}

/**
 * Send this process's log lines to a fresh file sink.
 * @returns A reader of the warn-level records that name a task.
 */
function captureWarnings(): (taskId: string) => Record<string, unknown>[] {
  const logsRoot = mkdtempSync(join(tmpdir(), "running-task-gate-"));
  initLogger("running-task-gate", { logsRoot, debug: false, console: "none" });
  return (taskId) => readdirSync(join(logsRoot, "running-task-gate"))
    .flatMap((file) => readFileSync(join(logsRoot, "running-task-gate", file), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.level === 40 && record.taskId === taskId);
}

describe("3.8 the gate's worker settings", () => {
  it("config/worker.yaml carries the stale window, the delay cap and the sweep interval (5.1 #15)", () => {
    const config = getWorkerConfig() as unknown as Record<string, unknown>;
    expect(config.slot_wait_stale_ms).toBe(STALE);
    expect(config.slot_wait_max_delay_ms).toBe(MAX_DELAY);
    expect(config.slot_wait_sweep_interval_ms).toBe(60_000);
    expect(getWorkerConfig().poll_interval).toBe(POLL);
  });
});

describe("G waiting for a free slot", () => {
  it("G-01 a third task of a base person running two waits: stays pending, records the wait, its node row queues, and comes back after one poll", async () => {
    const p = await person();
    await running(p, 2);
    const t = await seedTask(p, { node: true });
    const before = await dbNow();
    const t0 = Date.now();
    const got = await pick(t.taskId);
    const t1 = Date.now();
    const after = await dbNow();
    expect(got).toMatchObject({ waiting: true });
    const resumeAt = (got as { resumeAt: number }).resumeAt;
    expect(resumeAt).toBeGreaterThanOrEqual(t0 + POLL);
    expect(resumeAt).toBeLessThanOrEqual(t1 + POLL);
    const row = await taskRow(t.taskId);
    expect(row.status).toBe("pending");
    expect(row.started_at).toBeNull();
    between(row.slot_wait_since, before, after);
    between(row.slot_checked_at, before, after);
    expect(row.slot_wait_limit).toBe(2);
    between((await nodeRow(t.nodeTaskId!)).waiting_since, before, after);
    expect(await nodeTaskService.countsFor({ projectId: p.projectId, nodeId: t.nodeId! })).toMatchObject({ running: 1, waiting: 1, done: 0, failed: 0, expired: 0 });
  });

  it("G-02 once a running task ends, the waiter starts: running from that moment, its node row no longer waits and counts from then", async () => {
    const p = await person();
    await running(p, 2);
    const t = await seedTask(p, { node: true });
    expect(await pick(t.taskId)).toMatchObject({ waiting: true });
    await sql`update tasks set status = 'completed', completed_at = now() where id = (select id from tasks where user_id = ${p.userId} and status = 'running' limit 1)`;
    const before = await dbNow();
    expect(await pick(t.taskId)).toEqual({ started: true });
    const after = await dbNow();
    const row = await taskRow(t.taskId);
    expect(row.status).toBe("running");
    between(row.started_at, before, after);
    const node = await nodeRow(t.nodeTaskId!);
    expect(node.waiting_since).toBeNull();
    between(node.started_at, before, after);
    expect(await nodeTaskService.countsFor({ projectId: p.projectId, nodeId: t.nodeId! })).toMatchObject({ running: 1, waiting: 0 });
  });

  it("G-03 a waiter picked twelve times never fails, and its check time is rewritten only once it is older than a third of the stale window", async () => {
    const p = await person("enterprise", 1);
    await running(p, 1);
    const t = await seedTask(p);
    expect(await pick(t.taskId)).toMatchObject({ waiting: true });
    const first = (await taskRow(t.taskId)).slot_checked_at;
    for (let i = 0; i < 11; i += 1) {
      expect(await pick(t.taskId)).toMatchObject({ waiting: true });
      const row = await taskRow(t.taskId);
      expect(row.status).toBe("pending");
      expect(row.slot_checked_at?.getTime()).toBe(first?.getTime());
    }
    const old = new Date((await dbNow()).getTime() - STALE / 3 - 1);
    await sql`update tasks set slot_checked_at = ${old} where id = ${t.taskId}`;
    const before = await dbNow();
    expect(await pick(t.taskId)).toMatchObject({ waiting: true });
    between((await taskRow(t.taskId)).slot_checked_at, before, await dbNow());
  });

  it("G-04 five workers picking five tasks of a base person at once start exactly two", async () => {
    const p = await person();
    const tasks = await Promise.all(Array.from({ length: 5 }, () => seedTask(p)));
    const got = await Promise.all(tasks.map((t) => pick(t.taskId)));
    expect(got.filter((g) => "started" in g)).toHaveLength(2);
    expect(await runningCount(p)).toBe(2);
    const [pending] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where user_id = ${p.userId} and status = 'pending'`;
    expect(pending!.n).toBe(3);
  });

  it("G-05 while another session holds the person's lock, the gate writes nothing and comes back after one poll", async () => {
    const p = await person();
    const t = await seedTask(p);
    const holder = await sql.reserve();
    try {
      await holder`select pg_advisory_lock(hashtext(${`running-tasks:${p.userId}`}))`;
      const [before] = await sql`select * from tasks where id = ${t.taskId}`;
      const t0 = Date.now();
      const got = await pick(t.taskId);
      const t1 = Date.now();
      expect(got).toMatchObject({ waiting: true });
      expect((got as { resumeAt: number }).resumeAt).toBeGreaterThanOrEqual(t0 + POLL);
      expect((got as { resumeAt: number }).resumeAt).toBeLessThanOrEqual(t1 + POLL);
      const [afterRow] = await sql`select * from tasks where id = ${t.taskId}`;
      expect(afterRow).toEqual(before);
    } finally {
      await holder`select pg_advisory_unlock(hashtext(${`running-tasks:${p.userId}`}))`;
      holder.release();
    }
  });

  it("G-06 with a limit of one, waiters start in the order they were created, whatever order they are picked in", async () => {
    const p = await person("enterprise", 1);
    await running(p, 1);
    const now = await dbNow();
    const waiting = { since: now, checkedAt: now, limit: 1 };
    const t1 = await seedTask(p, { createdAt: new Date(now.getTime() - 3000), waiting });
    const t2 = await seedTask(p, { createdAt: new Date(now.getTime() - 2000), waiting });
    const t3 = await seedTask(p, { createdAt: new Date(now.getTime() - 1000), waiting });
    await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
    expect(await pick(t3.taskId)).toMatchObject({ waiting: true });
    expect(await pick(t2.taskId)).toMatchObject({ waiting: true });
    expect(await pick(t1.taskId)).toEqual({ started: true });
    await sql`update tasks set status = 'completed', completed_at = now() where id = ${t1.taskId}`;
    expect(await pick(t3.taskId)).toMatchObject({ waiting: true });
    expect(await pick(t2.taskId)).toEqual({ started: true });
    await sql`update tasks set status = 'completed', completed_at = now() where id = ${t2.taskId}`;
    expect(await pick(t3.taskId)).toEqual({ started: true });
  });

  it("G-07 a task in a team studio is held to the team limit and to waiters under that limit only", async () => {
    const u = await person();
    const now = await dbNow();
    await running(u, 2);
    for (let i = 0; i < 8; i += 1) {
      await seedTask(u, { createdAt: new Date(now.getTime() - 60_000 + i), waiting: { since: now, checkedAt: now, limit: 2 } });
    }
    const admin = await person("team");
    const teamStudio = crypto.randomUUID();
    const teamProject = crypto.randomUUID();
    await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${teamStudio}, ${admin.userId}, ${`g-${teamStudio}`}, 'team', 'Gate team')`;
    await sql`insert into studio_members(studio_id, user_id, role) values (${teamStudio}, ${admin.userId}, 'admin'), (${teamStudio}, ${u.userId}, 'editor')`;
    await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${teamProject}, ${teamStudio}, ${admin.userId}, ${`g-${teamProject}`}, 'Gate team')`;
    const t = await seedTask(u, { projectId: teamProject });
    expect(await pick(t.taskId)).toEqual({ started: true });
  });

  it("G-08 a waiter not checked within the stale window no longer holds a later task back", async () => {
    const now = await dbNow();
    const stale = await person();
    await running(stale, 1);
    await seedTask(stale, { createdAt: new Date(now.getTime() - 10_000), waiting: { since: now, checkedAt: new Date(now.getTime() - STALE - 1), limit: 2 } });
    expect(await pick((await seedTask(stale)).taskId)).toEqual({ started: true });

    const fresh = await person();
    await running(fresh, 1);
    await seedTask(fresh, { createdAt: new Date(now.getTime() - 10_000), waiting: { since: now, checkedAt: now, limit: 2 } });
    expect(await pick((await seedTask(fresh)).taskId)).toMatchObject({ waiting: true });
  });

  it("G-09 a running row past its budget and the report grace holds no slot", async () => {
    const p = await person("enterprise", 1);
    const now = await dbNow();
    await running(p, 1, new Date(now.getTime() - (B + REPORT_GRACE_MS) - 1));
    expect(await pick((await seedTask(p)).taskId)).toEqual({ started: true });
  });

  it("G-10 a running row just inside its budget and the report grace still holds its slot", async () => {
    const p = await person("enterprise", 1);
    const now = await dbNow();
    await running(p, 1, new Date(now.getTime() - (B + REPORT_GRACE_MS) + 1000));
    expect(await pick((await seedTask(p)).taskId)).toMatchObject({ waiting: true });
  });

  it("G-11 a running and a cancelling Timeline execution take both base slots; queued and awaiting landing take none", async () => {
    const p = await person();
    await execution(p, "running");
    await execution(p, "cancelling");
    await execution(p, "queued");
    await execution(p, "awaiting_landing");
    expect(await pick((await seedTask(p)).taskId)).toMatchObject({ waiting: true });

    const q = await person();
    await execution(q, "queued");
    await execution(q, "awaiting_landing");
    expect(await pick((await seedTask(q)).taskId)).toEqual({ started: true });
  });

  it("G-12 a running task and a running Timeline execution together hold a third of either kind back", async () => {
    const p = await person();
    await running(p, 1);
    await execution(p, "running");
    expect(await pick((await seedTask(p)).taskId)).toMatchObject({ waiting: true });
    const queued = await execution(p, "queued");
    expect(await pick(queued, "timeline_executions")).toMatchObject({ waiting: true });
    const [row] = await sql<{ status: string; slot_wait_since: Date | null }[]>`select status, slot_wait_since from timeline_executions where id = ${queued}`;
    expect(row).toMatchObject({ status: "queued" });
    expect(row!.slot_wait_since).not.toBeNull();
  });

  it("G-13 G-22 a node row that waited three hours is not harvested, and once started counts its budget from the start", async () => {
    const p = await person();
    await running(p, 2);
    const now = await dbNow();
    const longAgo = new Date(now.getTime() - 10_800_000);
    const t = await seedTask(p, { node: true, nodeStartedAt: longAgo, createdAt: longAgo, waiting: { since: longAgo, checkedAt: now, limit: 2 } });
    const listed = await nodeTaskService.harvestAndList({ projectId: p.projectId, nodeId: t.nodeId! });
    expect((await nodeRow(t.nodeTaskId!)).status).toBe("running");
    expect(listed.counts).toMatchObject({ running: 1, waiting: 1, expired: 0 });
    await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
    const before = await dbNow();
    expect(await pick(t.taskId)).toEqual({ started: true });
    const after = await dbNow();
    const deadline = await nodeTaskService.deadlineFor(t.taskId);
    expect(deadline).toBeGreaterThanOrEqual(before.getTime() + B - 1);
    expect(deadline).toBeLessThanOrEqual(after.getTime() + B + 1);
  });

  it("G-14 a wait renews holdings only once less than half the budget is left, to now + budget + grace", async () => {
    const p = await person();
    await running(p, 2);
    const now = await dbNow();
    const keep = await seedTask(p);
    const renew = await seedTask(p);
    const keepAt = new Date(now.getTime() + 3_700_000);
    await inFlight(p, keep.taskId, keepAt);
    await inFlight(p, renew.taskId, new Date(now.getTime() + 3_500_000));
    expect(await pick(keep.taskId)).toMatchObject({ waiting: true });
    const before = await dbNow();
    expect(await pick(renew.taskId)).toMatchObject({ waiting: true });
    const after = await dbNow();
    const kept = await holdings(keep.taskId);
    for (const held of [kept.credit, kept.overage, kept.ledger]) expect(held.expires_at.getTime()).toBe(keepAt.getTime());
    const renewed = await holdings(renew.taskId);
    for (const held of [renewed.credit, renewed.overage, renewed.ledger]) {
      expect(held.expires_at.getTime()).toBeGreaterThanOrEqual(before.getTime() + B + REPORT_GRACE_MS - 1);
      expect(held.expires_at.getTime()).toBeLessThanOrEqual(after.getTime() + B + REPORT_GRACE_MS + 1);
    }
  });

  it("G-16 starting renews holdings to now + budget + grace whatever is left", async () => {
    const p = await person();
    const now = await dbNow();
    const t = await seedTask(p);
    await inFlight(p, t.taskId, new Date(now.getTime() + 3_700_000));
    const before = await dbNow();
    expect(await pick(t.taskId)).toEqual({ started: true });
    const after = await dbNow();
    const held = await holdings(t.taskId);
    for (const h of [held.credit, held.overage, held.ledger]) {
      expect(h.status).not.toBe("released");
      expect(h.expires_at.getTime()).toBeGreaterThanOrEqual(before.getTime() + B + REPORT_GRACE_MS - 1);
      expect(h.expires_at.getTime()).toBeLessThanOrEqual(after.getTime() + B + REPORT_GRACE_MS + 1);
    }
  });

  it("G-17 a task with no node row that waited counts its deadline from its start, not its creation", async () => {
    const p = await person();
    const now = await dbNow();
    const t = await seedTask(p, { createdAt: new Date(now.getTime() - 3_600_000), waiting: { since: now, checkedAt: now, limit: 2 } });
    expect(await pick(t.taskId)).toEqual({ started: true });
    const row = await taskRow(t.taskId);
    expect(await taskDeadline(t.taskId, new Date(now.getTime() - 3_600_000))).toBe(row.started_at!.getTime() + B);
  });

  it("G-18 a retryable failure leaves the task running and holding its slot; the retry keeps its first start", async () => {
    const p = await person("enterprise", 1);
    const t = await seedTask(p);
    expect(await pick(t.taskId)).toEqual({ started: true });
    const firstStart = (await taskRow(t.taskId)).started_at;
    await finishFailedRun({
      streamRedis: getStreamRedis(),
      taskId: t.taskId,
      projectId: p.projectId,
      spaceId: p.spaceId,
      canvasDocName: null,
      nodeIds: [],
      userId: p.userId,
      model: "flux-schnell",
      params: {},
      source: undefined,
      toolId: undefined,
      errorMessage: "upstream failed",
      settles: false,
    });
    expect(await taskRow(t.taskId)).toMatchObject({ status: "running", error_message: "upstream failed" });
    expect(await pick((await seedTask(p)).taskId)).toMatchObject({ waiting: true });
    expect((await taskService.markRunning(t.taskId, `job-${t.taskId}`, new Date())).getTime()).toBe(firstStart!.getTime());
    expect((await taskRow(t.taskId)).status).toBe("running");
  });

  it("G-19 a waiter whose job fails for good is failed with its holdings released, and the next waiter starts", async () => {
    const p = await person("enterprise", 1);
    await running(p, 1);
    const now = await dbNow();
    const doomed = await seedTask(p, { node: true, createdAt: new Date(now.getTime() - 2000), waiting: { since: now, checkedAt: now, limit: 1 } });
    await inFlight(p, doomed.taskId, new Date(now.getTime() + B));
    const next = await seedTask(p, { createdAt: new Date(now.getTime() - 1000), waiting: { since: now, checkedAt: now, limit: 1 } });
    await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
    await cleanupFailedJobNodes(getStreamRedis(), {
      data: { taskId: doomed.taskId, taskType: "image", userId: p.userId, projectId: p.projectId, spaceId: p.spaceId, params: {}, model: "flux-schnell", mode: "append" },
      finishedOn: Date.now(),
    }, "job stalled more than allowable limit");
    expect((await taskRow(doomed.taskId)).status).toBe("failed");
    const held = await holdings(doomed.taskId);
    expect(held.credit.status).toBe("released");
    expect(held.overage.status).toBe("released");
    expect(held.ledger.status).toBe("released");
    expect((await nodeRow(doomed.nodeTaskId!)).status).toBe("failed");
    expect(await pick(next.taskId)).toEqual({ started: true });
  });

  it("G-20 the sweep fails a stale waiter whose job is gone, releasing its holdings and its node row", async () => {
    const { sweepSlotWaiters } = (await import("@worker/handlers/slot-wait-sweep.js")) as { sweepSlotWaiters: (queue: unknown) => Promise<void> };
    const p = await person();
    const now = await dbNow();
    const old = new Date(now.getTime() - STALE - 1000);
    const t = await seedTask(p, { node: true, waiting: { since: old, checkedAt: old, limit: 2 } });
    await inFlight(p, t.taskId, new Date(now.getTime() + B));
    await sweepSlotWaiters({ getJob: async () => undefined });
    expect((await taskRow(t.taskId)).status).toBe("failed");
    const held = await holdings(t.taskId);
    expect([held.credit.status, held.overage.status, held.ledger.status]).toEqual(["released", "released", "released"]);
    const node = await nodeRow(t.nodeTaskId!);
    expect(node.status).toBe("failed");
  });

  it.each(["active", "waiting", "delayed", "prioritized", "waiting-children"])("G-21 the sweep leaves a stale waiter whose job is %s alone and warns", async (state) => {
    const { sweepSlotWaiters } = (await import("@worker/handlers/slot-wait-sweep.js")) as { sweepSlotWaiters: (queue: unknown) => Promise<void> };
    const warnings = captureWarnings();
    const p = await person();
    const old = new Date((await dbNow()).getTime() - STALE - 1000);
    const t = await seedTask(p, { waiting: { since: old, checkedAt: old, limit: 2 } });
    await sweepSlotWaiters({ getJob: async (id: string) => (id === `job-${t.taskId}` ? { id, getState: async () => state } : undefined) });
    expect((await taskRow(t.taskId)).status).toBe("pending");
    expect(warnings(t.taskId)).toHaveLength(1);
  });

  it("G-21 the sweep leaves a stale waiter with no job id alone, as checkRun treats it as still running", async () => {
    const { sweepSlotWaiters } = (await import("@worker/handlers/slot-wait-sweep.js")) as { sweepSlotWaiters: (queue: unknown) => Promise<void> };
    const p = await person();
    const old = new Date((await dbNow()).getTime() - STALE - 1000);
    const t = await seedTask(p, { jobId: null, waiting: { since: old, checkedAt: old, limit: 2 } });
    await sweepSlotWaiters({ getJob: async () => undefined });
    expect((await taskRow(t.taskId)).status).toBe("pending");
  });

  it("G-23 a row the old code failed while its node row and holdings stayed open is finished on pickup, and a second pickup changes nothing", async () => {
    const p = await person();
    const t = await seedTask(p, { status: "failed", node: true });
    await inFlight(p, t.taskId, new Date((await dbNow()).getTime() + B));
    expect(await pick(t.taskId)).toEqual({ ended: true });
    expect((await nodeRow(t.nodeTaskId!)).status).toBe("failed");
    const held = await holdings(t.taskId);
    expect([held.credit.status, held.overage.status, held.ledger.status]).toEqual(["released", "released", "released"]);
    const snapshot = async (): Promise<unknown[]> => [
      await taskRow(t.taskId),
      await nodeRow(t.nodeTaskId!),
      await holdings(t.taskId),
    ];
    const first = await snapshot();
    expect(await pick(t.taskId)).toEqual({ ended: true });
    expect(await snapshot()).toEqual(first);
  });

  it("G-24 markRunning leaves a failed row failed", async () => {
    const p = await person();
    const t = await seedTask(p, { status: "failed" });
    await taskService.markRunning(t.taskId, `job-${t.taskId}`, new Date()).catch(() => undefined);
    expect((await taskRow(t.taskId)).status).toBe("failed");
  });

  it("G-30 lowering the limit interrupts nothing that runs; a new task waits until fewer than the new limit run", async () => {
    const p = await person("enterprise", 2);
    await running(p, 4);
    const t = await seedTask(p);
    expect(await pick(t.taskId)).toMatchObject({ waiting: true });
    expect(await runningCount(p)).toBe(4);
    await sql`update tasks set status = 'completed', completed_at = now() where id in (select id from tasks where user_id = ${p.userId} and status = 'running' limit 2)`;
    expect(await pick(t.taskId)).toMatchObject({ waiting: true });
    await sql`update tasks set status = 'completed', completed_at = now() where id in (select id from tasks where user_id = ${p.userId} and status = 'running' limit 1)`;
    expect(await pick(t.taskId)).toEqual({ started: true });
  });

  it("G-31 an agreement of 30 holds the 31st, a missing agreement the 11th, and self-hosted starts the 9999th", async () => {
    const agreed = await person("enterprise", 30);
    await running(agreed, 30);
    expect(await pick((await seedTask(agreed)).taskId)).toMatchObject({ waiting: true });

    const missing = await person("enterprise_missing");
    await running(missing, 9);
    expect(await pick((await seedTask(missing)).taskId)).toEqual({ started: true });
    expect(await pick((await seedTask(missing)).taskId)).toMatchObject({ waiting: true });

    const selfHosted = await person("self_hosted");
    await running(selfHosted, 9998);
    expect(await pick((await seedTask(selfHosted)).taskId)).toEqual({ started: true });
    expect(await pick((await seedTask(selfHosted)).taskId)).toMatchObject({ waiting: true });
  });

  it("G-32 a waiter comes back later the further back it stands, capped at the maximum delay", async () => {
    const p = await person();
    await running(p, 2);
    const now = await dbNow();
    const fresh = { since: now, checkedAt: now, limit: 2 };
    await sql`insert into tasks(user_id, project_id, space_id, task_type, mode, model, status, params, created_at, slot_wait_since, slot_checked_at, slot_wait_limit)
      select ${p.userId}, ${p.projectId}, ${p.spaceId}, 'image', 'append', 'flux-schnell', 'pending', '{}'::jsonb, ${new Date(now.getTime() - 600_000)}::timestamptz + make_interval(secs => i), ${now}, ${now}, 2
      from generate_series(1, 3) as i`;
    const fourth = await seedTask(p, { createdAt: new Date(now.getTime() - 500_000), waiting: fresh });
    const t0 = Date.now();
    const got = await pick(fourth.taskId);
    const t1 = Date.now();
    // L = 2, R = 2, W = 3: 3000 × (3 − 0 + 1) = 12,000.
    expect((got as { resumeAt: number }).resumeAt).toBeGreaterThanOrEqual(t0 + 12_000);
    expect((got as { resumeAt: number }).resumeAt).toBeLessThanOrEqual(t1 + 12_000);
    await sql`insert into tasks(user_id, project_id, space_id, task_type, mode, model, status, params, created_at, slot_wait_since, slot_checked_at, slot_wait_limit)
      select ${p.userId}, ${p.projectId}, ${p.spaceId}, 'image', 'append', 'flux-schnell', 'pending', '{}'::jsonb, ${new Date(now.getTime() - 400_000)}::timestamptz + make_interval(secs => i), ${now}, ${now}, 2
      from generate_series(1, 295) as i`;
    const last = await seedTask(p);
    const t2 = Date.now();
    const back = await pick(last.taskId);
    const t3 = Date.now();
    expect((back as { resumeAt: number }).resumeAt).toBeGreaterThanOrEqual(t2 + MAX_DELAY);
    expect((back as { resumeAt: number }).resumeAt).toBeLessThanOrEqual(t3 + MAX_DELAY);
  });

  it("G-33 recently checked queued waiters do not fill the Timeline sweep's window: an expired execution behind 300 of them is ended in one round", async () => {
    const p = await person();
    const now = await dbNow();
    const waiters: string[] = [];
    for (let i = 0; i < 300; i += 1) waiters.push(await execution(p, "queued"));
    await sql`update timeline_executions set slot_wait_since = ${now}, slot_checked_at = ${now}, slot_wait_limit = 2, created_at = ${new Date(now.getTime() - 3_600_000)} where id = any(${waiters})`;
    const expired = await execution(p, "awaiting_landing", new Date(now.getTime() - 60_000));
    const key = `timeline:${expired}`;
    await sql`insert into operation_ledger(operation_key, kind, account_user_id, studio_id, project_id, actor_user_id, status, admitted_as, expires_at)
      values (${key}, 'timeline', ${p.userId}, ${p.studioId}, ${p.projectId}, ${p.userId}, 'reserved', 'covered', ${new Date(now.getTime() + B)})`;
    await sweepTimelineExecutions({ add: async () => undefined, getJob: async () => undefined } as unknown as Parameters<typeof sweepTimelineExecutions>[0]);
    const [row] = await sql<{ status: string }[]>`select status from timeline_executions where id = ${expired}`;
    expect(row!.status).toBe("expired");
    const [ledger] = await sql<{ status: string }[]>`select status from operation_ledger where operation_key = ${key}`;
    expect(ledger!.status).toBe("released");
  });
});

describe("PT-4 the gate under concurrent pickups (K1, K4, K5)", () => {
  it("never starts a task when the person already runs their limit, never fails a waiter, and starts each row once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(1, 2, 3, 10),
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.record({ workers: fc.integer({ min: 1, max: 4 }), finish: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 8 }),
        async (limit, n, rounds) => {
          const p = await person("enterprise", limit);
          const base = await dbNow();
          const ids: string[] = [];
          for (let i = 0; i < n; i += 1) ids.push((await seedTask(p, { createdAt: new Date(base.getTime() - 60_000 + i) })).taskId);
          const startedOnce = new Set<string>();
          for (const round of rounds) {
            const pending = (await sql<{ id: string }[]>`select id from tasks where user_id = ${p.userId} and status = 'pending' order by created_at`).map((r) => r.id);
            const batch = pending.slice(0, round.workers);
            const got = await Promise.all(batch.map((id) => pick(id)));
            got.forEach((g, i) => {
              if (!("started" in g)) return;
              expect(startedOnce.has(batch[i]!)).toBe(false);
              startedOnce.add(batch[i]!);
            });
            // K1: no pickup took the person past the limit.
            expect(await runningCount(p)).toBeLessThanOrEqual(limit);
            // K4: waiting never fails a row.
            const [failed] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where user_id = ${p.userId} and status = 'failed'`;
            expect(failed!.n).toBe(0);
            if (round.finish > 0) {
              await sql`update tasks set status = 'completed', completed_at = now() where id in (select id from tasks where user_id = ${p.userId} and status = 'running' order by started_at limit ${round.finish})`;
            }
          }
          expect(ids.length).toBe(n);
        },
      ),
      { numRuns: 100 },
    );
  });
});
