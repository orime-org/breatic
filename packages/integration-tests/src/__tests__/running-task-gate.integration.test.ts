// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * How many tasks one person may run at once (inner#1968, test spec area G:
 * G-01 to G-21, G-23, G-24, G-30 to G-33, the F8 waiting and fresh cells
 * G-43 to G-45; invariants K1 to K4; PT-4).
 *
 * The worker calls the domain gate (`runningSlotService.startWithinLimit` for a
 * task, `claimWithinLimit` for a Timeline execution) for a row nobody has taken yet (`tasks.status = 'pending'`, Timeline `queued`).
 * Under `pg_try_advisory_xact_lock(hashtext('running-tasks:' || user_id))` it
 * counts what the person runs (`R`: `tasks` running within
 * `default_budget_ms + reportGraceMs()` of their start, plus Timeline
 * `running`/`cancelling` within `timelineReportGraceMs()` of their deadline) and the
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
 * Shapes this suite chose where the design names none: the gate is
 * `startWithinLimit({ id, jobId })` for a task and `claimWithinLimit(id)` for a
 * Timeline execution; each resolves `{ outcome: "started", started }` (the
 * task's start, or the execution as its claim wrote it) or, for a row it did
 * not start, `{ outcome: "ended" }`; waiting is the thrown error named `StillRunning` carrying `resumeAt` (epoch
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
import { Worker, type Job, type Queue } from "bullmq";
import { canvasSpaceDocName, threeDSpaceDocName, timelineSpaceDocName, webAnimationSpaceDocName } from "@breatic/shared";
import { createQueue, getNodeTaskConfig, getStreamRedis, getWorkerConfig, initCore, initLogger, loadLocales, reportGraceMs, taskEventsStreamKey } from "@breatic/core";
import { nodeTaskService, runningSlotService, sceneTaskService, taskService, type TimelineExecutionJobData, timelineExecutionRepo } from "@breatic/domain";
import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";
import { finishFailedRun, runTask, type TaskJobData } from "@worker/handlers/dispatch.js";
import { listSpaceTasks } from "@server/modules/asset/scene-tasks.service.js";
import { taskDeadline } from "@worker/handlers/task-deadline.js";
import { sweepSlotWaiters } from "@worker/handlers/slot-wait-sweep.js";
import { sweepTimelineExecutions } from "@worker/handlers/timeline/timeline-sweep.js";
import { runTimelineExecution } from "@worker/handlers/timeline/web-animation-execution.js";
import { listenSpaceTaskSignals, spaceTasksVersion } from "@server/__tests__/integration/helpers/space-task-signals.js";

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
    await sql`insert into enterprise_memberships(user_id,expires_at,entry_timezone,contract_number,team_studios,projects_per_studio,concurrent_editors,studio_members,project_members,storage_bytes,fallback_tier,revision,running_tasks_per_user)
      values(${userId}, now() + interval '30 days', 'UTC', 'TEST-ENT-1968', 8, 20, 30, 200, 80, 1099511627776, 'base', 1, ${runningTasks})`;
  }
  await sql`insert into studios(id, created_by_user_id, slug, type, name) values (${studioId}, ${userId}, ${`g-${studioId}`}, 'personal', 'Gate')`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${studioId}, ${userId}, 'admin')`;
  await sql`insert into projects(id, studio_id, created_by_user_id, slug, name) values (${projectId}, ${studioId}, ${userId}, ${`g-${projectId}`}, 'Gate')`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${projectId}, ${userId}, 'owner', null)`;
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
  /** The task type; an image generation by default. */
  taskType?: string;
  /** Open the node row as a 3D Space's own row (no node). */
  scene?: boolean;
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
    task_type: s.taskType ?? "image",
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
  if (!s.node && !s.scene) return { taskId, nodeId: null, nodeTaskId: null };
  const nodeId = s.scene ? null : crypto.randomUUID();
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
  if (s.scene) node.origin = "space";
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
    const out = table === "tasks" ? await runningSlotService.startWithinLimit({ id, jobId: `job-${id}` }) : await runningSlotService.claimWithinLimit(id);
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
 * The credit hold an admitted task holds, expiring at `expiresAt`.
 * @param p - Whose.
 * @param taskId - The task.
 * @param expiresAt - When it stops counting.
 */
async function inFlight(p: Person, taskId: string, expiresAt: Date): Promise<void> {
  await sql`insert into credit_holds(studio_id, actor_user_id, reference_id, amount, status, expires_at) values (${p.studioId}, ${p.userId}, ${taskId}, 1, 'held', ${expiresAt})`;
}

/**
 * What an admitted task holds: its credit hold.
 * @param taskId - The task.
 * @returns Its status and expiry.
 */
async function holdings(taskId: string): Promise<{ credit: { status: string; expires_at: Date } }> {
  const [credit] = await sql<{ status: string; expires_at: Date }[]>`select status, expires_at from credit_holds where reference_id = ${taskId}`;
  return { credit: credit! };
}

/**
 * A Timeline execution of the person's, moved to the state the case starts from.
 * @param p - Whose.
 * @param state - Where it starts.
 * @param deadlineAt - Its deadline; two hours on by default.
 * @param origin - Which Space type it belongs to, whose document its changes are told to; Motion by default.
 * @returns Its id.
 */
async function execution(p: Person, state: "awaiting_landing" | "queued" | "running" | "cancelling", deadlineAt = new Date(Date.now() + 2 * 3_600_000), origin: "web_animation_space" | "timeline" = "web_animation_space"): Promise<string> {
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
    origin,
  });
  if (row === null) throw new Error("fixture execution conflicted");
  const step = async (event: Parameters<typeof timelineExecutionRepo.transition>[0]["event"]): Promise<void> => {
    const result = await timelineExecutionRepo.transition({ id: row.id, event });
    if (!result.applied) throw new Error(`fixture step ${event.type} refused`);
  };
  // Only rows written before #1490 are awaiting landing; nothing writes that state now.
  if (state === "awaiting_landing") await sql`update timeline_executions set status = 'awaiting_landing' where id = ${row.id}`;
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
    // Design 21 row 22: the queued cell's tip names the limit the task waits under.
    expect((await nodeTaskService.countsFor({ projectId: p.projectId, nodeId: t.nodeId! })).waitingLimit).toBe(2);
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
    await running(p, 1, new Date(now.getTime() - (B + reportGraceMs()) - 1));
    expect(await pick((await seedTask(p)).taskId)).toEqual({ started: true });
  });

  it("G-10 a running row just inside its budget and the report grace still holds its slot", async () => {
    const p = await person("enterprise", 1);
    const now = await dbNow();
    await running(p, 1, new Date(now.getTime() - (B + reportGraceMs()) + 1000));
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
    expect(kept.credit.expires_at.getTime()).toBe(keepAt.getTime());
    const renewed = await holdings(renew.taskId);
    expect(renewed.credit.expires_at.getTime()).toBeGreaterThanOrEqual(before.getTime() + B + reportGraceMs() - 1);
    expect(renewed.credit.expires_at.getTime()).toBeLessThanOrEqual(after.getTime() + B + reportGraceMs() + 1);
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
    expect(held.credit.status).not.toBe("released");
    expect(held.credit.expires_at.getTime()).toBeGreaterThanOrEqual(before.getTime() + B + reportGraceMs() - 1);
    expect(held.credit.expires_at.getTime()).toBeLessThanOrEqual(after.getTime() + B + reportGraceMs() + 1);
  });

  it("G-17 a task with no node row that waited counts its deadline from its start, not its creation", async () => {
    const p = await person();
    const now = await dbNow();
    const t = await seedTask(p, { createdAt: new Date(now.getTime() - 3_600_000), waiting: { since: now, checkedAt: now, limit: 2 } });
    expect(await pick(t.taskId)).toEqual({ started: true });
    const row = await taskRow(t.taskId);
    // The start the worker reads off the row after the gate lets the task go, an hour after its creation.
    expect(row.started_at!.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(await taskDeadline(t.taskId, row.started_at!)).toBe(row.started_at!.getTime() + B);
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
    expect((await nodeRow(doomed.nodeTaskId!)).status).toBe("failed");
    expect(await pick(next.taskId)).toEqual({ started: true });
  });

  it("G-19 a 3D Space's own row of a task whose job fails for good ends with our code, read in each member's language", async () => {
    const p = await person("enterprise", 1);
    const now = await dbNow();
    const doomed = await seedTask(p, { scene: true, taskType: "three_d", waiting: { since: now, checkedAt: now, limit: 1 } });
    await inFlight(p, doomed.taskId, new Date(now.getTime() + B));
    await cleanupFailedJobNodes(getStreamRedis(), {
      data: { taskId: doomed.taskId, taskType: "three_d", userId: p.userId, projectId: p.projectId, spaceId: p.spaceId, sceneRowId: doomed.nodeTaskId!, params: {}, model: "tripo-h3.1-t23d", mode: "append" },
      finishedOn: Date.now(),
    }, "job stalled more than allowable limit");
    expect((await taskRow(doomed.taskId)).status).toBe("failed");
    expect(await nodeRow(doomed.nodeTaskId!)).toMatchObject({ status: "failed", error_message: "internal" });
  });

  it("a waiter whose job id was never recorded gets the id of the job that judged it, so the sweep can end it once that job is gone", async () => {
    const p = await person("enterprise", 1);
    await running(p, 1);
    const t = await seedTask(p, { node: true, jobId: null });
    expect(await pick(t.taskId)).toMatchObject({ waiting: true });
    const [row] = await sql<{ arq_job_id: string | null }[]>`select arq_job_id from tasks where id = ${t.taskId}`;
    expect(row!.arq_job_id).toBe(`job-${t.taskId}`);
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
    expect(held.credit.status).toBe("released");
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
    expect(held.credit.status).toBe("released");
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
    await sweepTimelineExecutions({ add: async () => undefined, getJob: async () => undefined } as unknown as Parameters<typeof sweepTimelineExecutions>[0]);
    const [row] = await sql<{ status: string }[]>`select status from timeline_executions where id = ${expired}`;
    expect(row!.status).toBe("expired");
  });
});

/**
 * A queued Timeline execution that already waits for a slot, its original deadline 1 ms gone, created first so the
 * sweep's window reaches it.
 * @param p - Whose.
 * @param checkedAt - When the gate last checked it.
 * @returns Its id.
 */
async function waitingExecution(p: Person, checkedAt: Date): Promise<string> {
  const id = await execution(p, "queued");
  const now = await dbNow();
  await sql`update timeline_executions set slot_wait_since = ${new Date(now.getTime() - 60_000)}, slot_checked_at = ${checkedAt}, slot_wait_limit = 2,
    deadline_at = ${new Date(now.getTime() - 1)}, created_at = '2000-01-01T00:00:00Z' where id = ${id}`;
  return id;
}

/**
 * Every stored column of a Timeline execution.
 * @param id - The execution.
 * @returns The row as read.
 */
async function executionRow(id: string): Promise<Record<string, unknown>> {
  const [row] = await sql<Record<string, unknown>[]>`select * from timeline_executions where id = ${id}`;
  return row!;
}

describe("G F8 a waiting Timeline execution has no deadline until it starts", () => {
  it("G-43 K4 a waiter past its original deadline is not expired by the take, by a deadline event or by the Timeline sweep", async () => {
    const p = await person();
    await running(p, 2);
    const now = await dbNow();
    const recent = await waitingExecution(p, now);
    const stale = await waitingExecution(p, new Date(now.getTime() - STALE - 1000));

    // 1. The take goes through the gate, which holds it back: no "past its deadline, end it" branch.
    const job = { data: { executionId: recent } } as unknown as Job<TimelineExecutionJobData>;
    const thrown = await runTimelineExecution(job).then(() => null, (err: unknown) => err);
    expect((thrown as Error | null)?.name).toBe("StillRunning");
    expect((await executionRow(recent)).status).toBe("queued");

    // 2. A deadline event changes neither row.
    for (const id of [recent, stale]) {
      const before = await executionRow(id);
      const moved = await timelineExecutionRepo.transition({ id, event: { type: "deadline" } });
      expect(moved.applied).toBe(false);
      expect(await executionRow(id)).toEqual(before);
    }

    // 3. The sweep leaves the recently checked waiter out and only puts the stale one's job back.
    const listed = (await timelineExecutionRepo.listForSweep({ limit: 100_000 })).map((r) => r.id);
    expect(listed).not.toContain(recent);
    expect(listed).toContain(stale);
    const asked: string[] = [];
    const added: string[] = [];
    await sweepTimelineExecutions({
      getJob: async (id: string) => { asked.push(id); return undefined; },
      add: async (_name: string, data: TimelineExecutionJobData) => { added.push(data.executionId); return undefined; },
    } as unknown as Parameters<typeof sweepTimelineExecutions>[0]);
    expect(asked).not.toContain(recent);
    expect(added).not.toContain(recent);
    expect(added).toContain(stale);

    for (const id of [recent, stale]) expect((await executionRow(id)).status).toBe("queued");
  });

  it("G-43b an export waits behind the gate like a create: its pickup holds the row back as queued (#1490)", async () => {
    const p = await person();
    await running(p, 2);
    const id = await execution(p, "queued");
    await sql`update timeline_executions set kind = 'web_animation_export', engine = null,
      input = ${sql.json({ kind: "web_animation_export", sourceVersionId: crypto.randomUUID(), width: 1080, height: 1920, fps: { num: 24, den: 1 }, durationFrames: 96, videoKey: "x.mp4" })}
      where id = ${id}`;
    const job = { data: { executionId: id } } as unknown as Job<TimelineExecutionJobData>;
    const thrown = await runTimelineExecution(job).then(() => null, (err: unknown) => err);
    expect((thrown as Error | null)?.name).toBe("StillRunning");
    const row = await executionRow(id);
    expect(row.status).toBe("queued");
    expect(row.slot_wait_since).not.toBeNull();
  });

  it("G-44 a waiter that starts gets a fresh deadline of start + budget, and later deadline checks use it", async () => {
    const p = await person();
    await running(p, 2);
    const id = await waitingExecution(p, await dbNow());
    expect(await pick(id, "timeline_executions")).toMatchObject({ waiting: true });
    await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
    const before = await dbNow();
    expect(await pick(id, "timeline_executions")).toEqual({ started: true });
    const after = await dbNow();
    const row = await executionRow(id);
    expect(row.status).toBe("running");
    const deadline = (row.deadline_at as Date).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before.getTime() + B - 1);
    expect(deadline).toBeLessThanOrEqual(after.getTime() + B + 1);
    // The original deadline has passed; the new one has not, so a deadline event does not expire it.
    const moved = await timelineExecutionRepo.transition({ id, event: { type: "deadline" } });
    expect(moved.applied).toBe(false);
    expect((await executionRow(id)).status).toBe("running");
  });
});

/**
 * Wait until a pickup holds its gate transaction open trying the person's lock:
 * it has read its row and now waits for the lock this case holds.
 * @returns Nothing.
 */
async function untilTryingLock(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
      where pid <> pg_backend_pid() and state in ('active', 'idle in transaction') and query ilike '%pg_try_advisory_xact_lock%'`;
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no pickup came to try the lock");
}

/**
 * Hold a person's lock while a pickup reads its row, change the row once the
 * pickup is trying the lock, then let it in.
 * @param userId - Whose lock.
 * @param pickup - Starts the pickup.
 * @param meanwhile - What another pickup did meanwhile.
 * @returns What the pickup came to.
 */
async function pickWhileAnotherMovesIt(userId: string, pickup: () => Promise<Picked>, meanwhile: () => Promise<unknown>): Promise<Picked> {
  const holder = await sql.reserve();
  let picked: Promise<Picked> | undefined;
  try {
    await holder`select pg_advisory_lock(hashtext(${`running-tasks:${userId}`}))`;
    picked = pickup();
    await untilTryingLock();
    await meanwhile();
  } finally {
    await holder`select pg_advisory_unlock(hashtext(${`running-tasks:${userId}`}))`;
    holder.release();
  }
  return picked;
}

// Two pickups of one task can judge it at once: one marks it waiting (task and
// node row) while the other, which read the task before that, starts it. The
// start must release the node row whatever its own read of the task said; and
// in the other order, a task another pickup started meanwhile stays running.
describe("G a start releases the node row another pickup marked waiting", () => {
  it("clears the node row's waiting mark although this pickup read the task as never waiting", async () => {
    const p = await person();
    const { taskId, nodeTaskId } = await seedTask(p, { node: true });
    await sql`update node_tasks set waiting_since = now() where id = ${nodeTaskId}`;
    expect(await pick(taskId)).toEqual({ started: true });
    expect((await nodeRow(nodeTaskId!)).waiting_since).toBeNull();
  });

  // The other order: this pickup read the task pending, another started it
  // while this one waited for the lock, and the one now running fills the limit.
  it("leaves a task another pickup started meanwhile running, its node row not waiting", async () => {
    const p = await person("enterprise", 1);
    const { taskId, nodeTaskId } = await seedTask(p, { node: true });
    const picked = await pickWhileAnotherMovesIt(p.userId, () => pick(taskId),
      () => sql`update tasks set status = 'running', started_at = now() where id = ${taskId}`);
    // It runs on under the start the other pickup stored, as a pickup of a running task does.
    expect(picked).toEqual({ started: true });
    expect((await taskRow(taskId)).status).toBe("running");
    expect((await nodeRow(nodeTaskId!)).waiting_since).toBeNull();
  });
});

// The worker times the task's budget from the start the gate answers, so it
// must be the stored one, whether this pickup started the task or another did.
describe("G the gate answers the task's stored start", () => {
  it("answers the start it wrote, and the stored start of a task another pickup started", async () => {
    const p = await person();
    const { taskId } = await seedTask(p);
    const first = await runningSlotService.startWithinLimit({ id: taskId, jobId: "job-a" });
    if (first.outcome !== "started") throw new Error("expected the gate to start it");
    const stored = (await taskRow(taskId)).started_at;
    expect(first.started).toEqual(stored);
    const again = await runningSlotService.startWithinLimit({ id: taskId, jobId: "job-b" });
    if (again.outcome !== "started") throw new Error("expected a running task to answer started");
    expect(again.started).toEqual(stored);
  });
});

// Two pickups of one execution can meet (a stalled worker, a redelivered job):
// the later one must not run under the earlier one's claim. The gate starts
// only a queued row and hands back what its own claim wrote; for any other it
// answers ended, and the take reads the row again and retries it with a fresh
// fence (inner#1968).
describe("G a Timeline pickup that finds the execution claimed by another", () => {
  it("answers ended for one another pickup claimed while this one waited for the lock, whatever the limit", async () => {
    const p = await person("enterprise", 1);
    const id = await execution(p, "queued");
    const picked = await pickWhileAnotherMovesIt(p.userId, () => pick(id, "timeline_executions"),
      () => timelineExecutionRepo.transition({ id, event: { type: "claim" } }));
    expect(picked).toEqual({ ended: true });
    expect(await executionRow(id)).toMatchObject({ status: "running", attempt: 1 });
  });

  it.each(["running", "cancelling"] as const)("answers ended for a %s execution and changes nothing", async (state) => {
    const p = await person();
    const id = await execution(p, state);
    const before = await executionRow(id);
    expect(await pick(id, "timeline_executions")).toEqual({ ended: true });
    expect(await executionRow(id)).toEqual(before);
  });

  it("hands back the execution as its own claim wrote it, with that claim's fence", async () => {
    const p = await person();
    const id = await execution(p, "queued");
    const out = await runningSlotService.claimWithinLimit(id);
    if (out.outcome !== "started") throw new Error("expected the claim to start it");
    const row = await executionRow(id);
    expect(row.status).toBe("running");
    expect(out.started.fence).toBe(row.fence);
    expect(out.started.attempt).toBe(row.attempt);
  });
});

describe("G F8 a task the gate has not judged keeps its node row's deadline", () => {
  it("G-45 both harvests expire a fresh task's overdue node row, and leave an equally overdue waiting row alone", async () => {
    const p = await person();
    const now = await dbNow();
    const overdue = new Date(now.getTime() - B - 1);
    const waiting = { since: now, checkedAt: now, limit: 2 };
    const freshNode = await seedTask(p, { node: true, nodeStartedAt: overdue });
    const freshScene = await seedTask(p, { scene: true, nodeStartedAt: overdue });
    const waitNode = await seedTask(p, { node: true, nodeStartedAt: overdue, waiting });
    const waitScene = await seedTask(p, { scene: true, nodeStartedAt: overdue, waiting });
    expect((await nodeRow(freshNode.nodeTaskId!)).waiting_since).toBeNull();
    expect((await taskRow(freshNode.taskId)).slot_wait_since).toBeNull();

    await nodeTaskService.harvestAndList({ projectId: p.projectId, nodeId: freshNode.nodeId! });
    await nodeTaskService.harvestAndList({ projectId: p.projectId, nodeId: waitNode.nodeId! });
    await sceneTaskService.harvestAndList(p.projectId, p.spaceId);

    expect(await nodeRow(freshNode.nodeTaskId!)).toMatchObject({ status: "expired", error_message: "expired" });
    expect(await nodeRow(freshScene.nodeTaskId!)).toMatchObject({ status: "expired", error_message: "expired" });
    expect((await nodeRow(waitNode.nodeTaskId!)).status).toBe("running");
    expect((await nodeRow(waitScene.nodeTaskId!)).status).toBe("running");
  });

  it("both harvests expire an overdue waiting row whose task already ended, so a cancel that committed before its rows settled leaves none behind", async () => {
    const p = await person();
    const now = await dbNow();
    const overdue = new Date(now.getTime() - B - 1);
    const waiting = { since: now, checkedAt: now, limit: 2 };
    const onNode = await seedTask(p, { node: true, nodeStartedAt: overdue, waiting });
    const onScene = await seedTask(p, { scene: true, nodeStartedAt: overdue, waiting });
    // The cancel's own commit, with the step that ends its rows never run.
    await sql`update tasks set status = 'cancelled' where id in (${onNode.taskId}, ${onScene.taskId})`;

    await nodeTaskService.harvestAndList({ projectId: p.projectId, nodeId: onNode.nodeId! });
    await sceneTaskService.harvestAndList(p.projectId, p.spaceId);

    expect(await nodeRow(onNode.nodeTaskId!)).toMatchObject({ status: "expired", error_message: "expired" });
    expect(await nodeRow(onScene.nodeTaskId!)).toMatchObject({ status: "expired", error_message: "expired" });
  });
});

/**
 * Every node-task-counts event the stream carries for one node.
 * @param p - Whose canvas.
 * @param nodeId - The node.
 * @returns Each event's counts, oldest first.
 */
async function countsEvents(p: Person, nodeId: string): Promise<Record<string, number>[]> {
  const raw = (await getStreamRedis().xrange(taskEventsStreamKey(), "-", "+")) as [string, string[]][];
  return raw
    .map(([, fields]) => JSON.parse(fields[fields.indexOf("payload") + 1]!) as Record<string, unknown>)
    .filter((e) => e.type === "node-task-counts" && e.docName === canvasSpaceDocName(p.projectId, p.spaceId) && e.nodeId === nodeId)
    .map((e) => e.counts as Record<string, number>);
}

/** A real BullMQ queue and a worker that takes its jobs by hand. */
interface Lane {
  queue: Queue;
  worker: Worker;
}

/**
 * A queue of its own and a hand-driven worker on it.
 * @returns Both.
 */
function lane(): Lane {
  const queue = createQueue(`gate-${crypto.randomUUID()}`);
  const worker = new Worker(queue.name, null, { connection: queue.opts.connection, lockDuration: 60_000, autorun: false });
  return { queue, worker };
}

/**
 * Queue a task's job and take it as the worker does, with its lock token.
 * @param l - The lane.
 * @param p - Whose task.
 * @param taskId - The task.
 * @param taskType - Its type.
 * @param nodeIds - The nodes it writes to.
 * @returns The active job and its token.
 */
async function takeJob(l: Lane, p: Person, taskId: string, taskType: string, nodeIds: string[] = []): Promise<{ job: Job<TaskJobData>; token: string }> {
  const existing = await l.queue.getJob(taskId);
  if (existing === undefined) {
    const data: TaskJobData = { taskId, taskType, userId: p.userId, projectId: p.projectId, spaceId: p.spaceId, params: {}, mode: "append", targetNodeIds: nodeIds };
    await l.queue.add("execute-task", data, { jobId: taskId, attempts: 3 });
  } else if ((await existing.getState()) === "delayed") {
    await existing.promote();
  }
  const token = crypto.randomUUID();
  const job = (await l.worker.getNextJob(token)) as Job<TaskJobData> | undefined;
  if (job === undefined || job.id !== taskId) throw new Error("the lane handed out another job");
  return { job, token };
}

describe("G the gate's caller puts a waiting job back on the queue (K4)", () => {
  it("G-03 K4 a job picked twelve times while its person runs their limit goes back delayed each time and spends no attempt", async () => {
    const p = await person("enterprise", 1);
    await running(p, 1);
    // A reading that names no node fails on its first line, so a pickup that
    // is not held back by the gate never reaches a paid call.
    const t = await seedTask(p, { taskType: "understand" });
    const l = lane();
    try {
      for (let i = 0; i < 12; i += 1) {
        const { job, token } = await takeJob(l, p, t.taskId, "understand");
        const thrown = await runTask(job, token).then(() => null, (err: unknown) => err);
        expect((thrown as Error | null)?.name).toBe("DelayedError");
        const stored = await l.queue.getJob(t.taskId);
        expect(await stored!.getState()).toBe("delayed");
        expect(stored!.attemptsMade).toBe(0);
        expect((await taskRow(t.taskId)).status).toBe("pending");
      }
    } finally {
      await l.worker.close();
      await l.queue.obliterate({ force: true });
      await l.queue.close();
    }
  });

  it("G-22 while the worker is away for minutes, reading the node list and the 3D list ends no waiting task, and the job starts once it is back", async () => {
    const p = await person();
    await running(p, 2);
    const now = await dbNow();
    const away = new Date(now.getTime() - 120_000);
    const waiting = { since: away, checkedAt: away, limit: 2 };
    const onNode = await seedTask(p, { node: true, taskType: "understand", nodeStartedAt: new Date(now.getTime() - B - 60_000), waiting });
    const onScene = await seedTask(p, { scene: true, nodeStartedAt: new Date(now.getTime() - B - 60_000), waiting });
    const l = lane();
    try {
      await l.queue.add("execute-task", { taskId: onNode.taskId, taskType: "understand", userId: p.userId, projectId: p.projectId, spaceId: p.spaceId, params: {}, mode: "append" } satisfies TaskJobData, { jobId: onNode.taskId, attempts: 3, delay: 60_000 });
      const listed = await nodeTaskService.harvestAndList({ projectId: p.projectId, nodeId: onNode.nodeId! });
      expect(listed.counts).toMatchObject({ running: 1, waiting: 1, expired: 0 });
      const scene = await sceneTaskService.harvestAndList(p.projectId, p.spaceId);
      expect(scene.harvested).toBe(0);
      const wire = await listSpaceTasks(p.userId, p.projectId, p.spaceId);
      const row = wire.tasks.find((x) => x.id === onScene.nodeTaskId) as Record<string, unknown> | undefined;
      expect(row).toMatchObject({ status: "running" });
      expect(row?.waitingSince).toBe(away.toISOString());
      expect((await nodeRow(onNode.nodeTaskId!)).status).toBe("running");
      expect((await taskRow(onNode.taskId)).status).toBe("pending");
      await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
      const { job, token } = await takeJob(l, p, onNode.taskId, "understand");
      await runTask(job, token).catch(() => undefined);
      const started = await taskRow(onNode.taskId);
      expect(started.status).not.toBe("pending");
      expect(started.started_at).not.toBeNull();
    } finally {
      await l.worker.close();
      await l.queue.obliterate({ force: true });
      await l.queue.close();
    }
  });
});

describe("G the node's counts event says how many wait", () => {
  it("first waiting publishes counts with waiting 1, and starting publishes waiting 0", async () => {
    const p = await person();
    await running(p, 2);
    const t = await seedTask(p, { node: true });
    expect(await pick(t.taskId)).toMatchObject({ waiting: true });
    expect((await countsEvents(p, t.nodeId!)).at(-1)).toMatchObject({ running: 1, waiting: 1 });
    await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
    expect(await pick(t.taskId)).toEqual({ started: true });
    expect((await countsEvents(p, t.nodeId!)).at(-1)).toMatchObject({ running: 1, waiting: 0 });
  });
});

describe("G a 3D Space's waiting row and a waiting Motion or Timeline execution tell their Space's document (#1580)", () => {
  it("first waiting and starting each tell the 3D Space's document, and the old channel nothing", async () => {
    const p = await person();
    await running(p, 2);
    const t = await seedTask(p, { scene: true });
    const docName = threeDSpaceDocName(p.projectId, p.spaceId);
    const version = spaceTasksVersion(docName);
    const spaceSignals = await listenSpaceTaskSignals();
    try {
      await spaceSignals.mark();
      const told = () => spaceSignals.read({ projectId: p.projectId, spaceId: p.spaceId, docName });
      expect(await pick(t.taskId)).toMatchObject({ waiting: true });
      expect(await told()).toEqual({ doc: [version], meta: [] });
      expect(await pick(t.taskId)).toMatchObject({ waiting: true });
      expect(await told()).toEqual({ doc: [version], meta: [] });
      await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
      expect(await pick(t.taskId)).toEqual({ started: true });
      expect(await told()).toEqual({ doc: [version, version], meta: [] });
    } finally {
      await spaceSignals.stop();
    }
  });

  it.each([
    ["Motion", "web_animation_space", webAnimationSpaceDocName],
    ["Timeline", "timeline", timelineSpaceDocName],
  ] as const)("first waiting and starting each tell the %s Space's document, and the old channel nothing", async (_name, origin, docNameOf) => {
    const p = await person();
    await running(p, 2);
    const id = await execution(p, "queued", undefined, origin);
    const docName = docNameOf(p.projectId, p.spaceId);
    const version = spaceTasksVersion(docName);
    const spaceSignals = await listenSpaceTaskSignals();
    try {
      await spaceSignals.mark();
      const told = () => spaceSignals.read({ projectId: p.projectId, spaceId: p.spaceId, docName });
      expect(await pick(id, "timeline_executions")).toMatchObject({ waiting: true });
      expect(await told()).toEqual({ doc: [version], meta: [] });
      expect(await pick(id, "timeline_executions")).toMatchObject({ waiting: true });
      expect(await told()).toEqual({ doc: [version], meta: [] });
      await sql`update tasks set status = 'completed', completed_at = now() where user_id = ${p.userId} and status = 'running'`;
      expect(await pick(id, "timeline_executions")).toEqual({ started: true });
      expect(await told()).toEqual({ doc: [version, version], meta: [] });
    } finally {
      await spaceSignals.stop();
    }
  });
});

/**
 * How many rows the person runs within their deadline, as the gate counts `R`.
 * @param p - Whose.
 * @returns Running tasks within budget and grace plus running or cancelling Timeline executions within grace of
 *   their deadline.
 */
async function inDeadlineRunning(p: Person): Promise<number> {
  const grace = reportGraceMs();
  const [row] = await sql<{ n: number }[]>`select
    (select count(*) from tasks where user_id = ${p.userId} and status = 'running' and started_at > now() - ${B + grace} * interval '1 millisecond')
    + (select count(*) from timeline_executions where actor_user_id = ${p.userId} and status in ('running', 'cancelling') and deadline_at > now() - ${grace} * interval '1 millisecond') as n`;
  return Number(row!.n);
}

/**
 * Move the person's clock on by writing every time column of their rows that far back.
 * @param p - Whose.
 * @param ms - How far.
 */
async function advance(p: Person, ms: number): Promise<void> {
  const by = sql`${ms} * interval '1 millisecond'`;
  await sql`update tasks set created_at = created_at - ${by}, started_at = started_at - ${by}, slot_wait_since = slot_wait_since - ${by}, slot_checked_at = slot_checked_at - ${by} where user_id = ${p.userId}`;
  await sql`update node_tasks set started_at = started_at - ${by}, waiting_since = waiting_since - ${by} where started_by_user_id = ${p.userId}`;
  await sql`update timeline_executions set created_at = created_at - ${by}, deadline_at = deadline_at - ${by}, slot_wait_since = slot_wait_since - ${by}, slot_checked_at = slot_checked_at - ${by} where actor_user_id = ${p.userId}`;
}

describe("PT-4 the gate under concurrent pickups (K1, K4, K5)", () => {
  it("PT-4 K1 K4 never starts past the limit, and a waiting row is never failed or expired because it waited, across clock jumps, harvests, deadline events and the Timeline sweep", async () => {
    const queue = { add: async () => undefined, getJob: async () => undefined } as unknown as Parameters<typeof sweepTimelineExecutions>[0];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(1, 2, 3, 10),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 3 }),
        fc.array(fc.record({
          workers: fc.integer({ min: 1, max: 4 }),
          finish: fc.integer({ min: 0, max: 2 }),
          advanceMs: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 4 * 3_600_000 })),
        }), { minLength: 1, maxLength: 8 }),
        async (limit, n, m, rounds) => {
          const p = await person("enterprise", limit);
          const base = await dbNow();
          const tasks: Seeded[] = [];
          for (let i = 0; i < n; i += 1) tasks.push(await seedTask(p, { node: true, createdAt: new Date(base.getTime() - 60_000 + i) }));
          const executions: string[] = [];
          for (let i = 0; i < m; i += 1) {
            const id = await execution(p, "queued");
            // Ahead of every other suite's rows, so the sweep's window reaches it.
            await sql`update timeline_executions set created_at = ${new Date(Date.UTC(1999, 0, 1) + i)} where id = ${id}`;
            executions.push(id);
          }
          try {
            const startedOnce = new Set<string>();
            for (const round of rounds) {
              const pendingTasks = (await sql<{ id: string }[]>`select id from tasks where id = any(${tasks.map((t) => t.taskId)}) and status = 'pending' order by created_at`).map((r) => ({ id: r.id, table: "tasks" as const }));
              const queued = executions.length === 0 ? [] : (await sql<{ id: string }[]>`select id from timeline_executions where id = any(${executions}) and status = 'queued' order by created_at`).map((r) => ({ id: r.id, table: "timeline_executions" as const }));
              const batch = [...pendingTasks, ...queued].slice(0, round.workers);
              const got = await Promise.all(batch.map((b) => pick(b.id, b.table)));
              got.forEach((g, i) => {
                if (!("started" in g)) return;
                expect(startedOnce.has(batch[i]!.id)).toBe(false);
                startedOnce.add(batch[i]!.id);
              });
              // K1: no pickup took the person past the limit.
              expect(await inDeadlineRunning(p)).toBeLessThanOrEqual(limit);

              // The rows that wait after this step's pickups.
              // A node row harvested while its task was still fresh (G-45) stays expired; this step must not
              // expire one that waits.
              const waitingTasks = tasks.length === 0 ? [] : await sql<{ id: string; node_status: string }[]>`select t.id, n.status as node_status from tasks t join node_tasks n on n.task_id = t.id
                where t.id = any(${tasks.map((x) => x.taskId)}) and t.status = 'pending' and t.slot_wait_since is not null`;
              const waitingExecutions = executions.length === 0 ? [] : await sql<{ id: string }[]>`select id from timeline_executions where id = any(${executions}) and status = 'queued' and slot_wait_since is not null`;

              if (round.finish > 0) {
                await sql`update tasks set status = 'completed', completed_at = now() where id in (select id from tasks where user_id = ${p.userId} and status = 'running' order by started_at limit ${round.finish})`;
                await sql`update timeline_executions set status = 'succeeded', fence = null where id in (select id from timeline_executions where actor_user_id = ${p.userId} and status = 'running' order by deadline_at limit ${round.finish})`;
              }
              if (round.advanceMs > 0) await advance(p, round.advanceMs);
              for (const t of tasks) await nodeTaskService.harvestAndList({ projectId: p.projectId, nodeId: t.nodeId! });
              await sceneTaskService.harvestAndList(p.projectId, p.spaceId);
              for (const id of executions) await timelineExecutionRepo.transition({ id, event: { type: "deadline" } });
              await sweepTimelineExecutions(queue);

              // K4: no event in this step ends a waiter, so every waiter still waits, its node row unharvested.
              for (const { id, node_status } of waitingTasks) {
                expect((await taskRow(id)).status).toBe("pending");
                const node = tasks.find((t) => t.taskId === id)!;
                expect((await nodeRow(node.nodeTaskId!)).status).toBe(node_status);
              }
              for (const { id } of waitingExecutions) expect((await executionRow(id)).status).toBe("queued");
              const [failed] = await sql<{ n: number }[]>`select count(*)::int as n from tasks where user_id = ${p.userId} and status = 'failed'`;
              expect(failed!.n).toBe(0);
            }
          } finally {
            // Leave no open execution behind for the other suites' sweeps.
            await sql`update timeline_executions set status = 'cancelled', fence = null where actor_user_id = ${p.userId} and status in ('awaiting_landing', 'queued', 'running', 'cancelling')`;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * A team studio of someone else's, on an enterprise agreement with its own
 * running-task limit, that the person works in.
 * @param p - Who joins it.
 * @param limit - The admin's `running_tasks_per_user`.
 * @returns The admin and the project the person works in there.
 */
async function otherStudio(p: Person, limit: number): Promise<{ adminId: string; projectId: string }> {
  const admin = await person("enterprise", limit);
  await sql`update studios set type = 'team' where id = ${admin.studioId}`;
  await sql`insert into studio_members(studio_id, user_id, role) values (${admin.studioId}, ${p.userId}, 'maintainer')`;
  await sql`insert into project_members(project_id, user_id, role, added_by) values (${admin.projectId}, ${p.userId}, 'editor', ${admin.userId})`;
  return { adminId: admin.userId, projectId: admin.projectId };
}

/** One round of PT-4's events. */
interface Pt4Round {
  /** Pickups in this round; one pickup checks `R + W < L` exactly. */
  workers: number;
  /** What else happens in it. */
  event: "finish" | "fail" | "cancel" | "advance" | "limit" | "lose";
  /** Which row or studio the event picks, modulo how many there are. */
  pickIndex: number;
  /** How far the clock moves, for `advance`. */
  advanceMs: number;
  /** The new limit, for `limit`. */
  limit: number;
}

describe("PT-4 the gate with cancels, failures, limit changes and lost jobs (K1, K2, K3, K4, K5)", () => {
  it("PT-4 K1 K3 starts a row only when R + W < L, K5 starts or cancels it at most once and a cancel racing a pickup takes effect once, K4 ends a waiter only by its cancel, its failure or its lost job, and K2 starts its budget and node row at the start", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.constantFrom(1, 2, 3, 10),
        fc.constantFrom(1, 2, 3, 10),
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.record({
          workers: fc.integer({ min: 1, max: 4 }),
          event: fc.constantFrom("finish", "fail", "cancel", "advance", "limit", "lose"),
          pickIndex: fc.nat(),
          advanceMs: fc.integer({ min: 1, max: 4 * 3_600_000 }),
          limit: fc.constantFrom(1, 2, 3, 10),
        }), { minLength: 1, maxLength: 8 }),
        async (twoPeople, ownLimit, otherLimit, n, rounds: Pt4Round[]) => {
          const people = [await person("enterprise", ownLimit)];
          if (twoPeople) people.push(await person("enterprise", ownLimit));
          const other = await otherStudio(people[0]!, otherLimit);
          /** The admin whose agreement sets each project's limit. */
          const adminOf = new Map<string, string>([[other.projectId, other.adminId], ...people.map((q) => [q.projectId, q.userId] as const)]);
          const base = await dbNow();
          const rows: (Seeded & { owner: Person })[] = [];
          for (let i = 0; i < n; i += 1) {
            const owner = people[i % people.length]!;
            const projectId = owner === people[0] && i % 3 === 2 ? other.projectId : owner.projectId;
            const seeded = await seedTask(owner, { node: true, projectId, createdAt: new Date(base.getTime() - 60_000 + i) });
            await inFlight(owner, seeded.taskId, new Date(base.getTime() + B));
            rows.push({ ...seeded, owner });
          }
          const ids = rows.map((r) => r.taskId);
          const lost = new Set<string>();
          // A job still waits unless the case lost it.
          const queue = { getJob: async (id: string) => (lost.has(id) ? undefined : { getState: async () => "delayed" }) } as unknown as Parameters<typeof sweepSlotWaiters>[0];
          const startedOnce = new Set<string>();
          const cancelledOnce = new Set<string>();
          /** Why a waiter may end in this round, by task id. */
          let mayEnd = new Map<string, "cancelled" | "failed">();

          /**
           * The limit a task waits under now, read from its studio's admin.
           * @param taskId - The task.
           * @returns `L`.
           */
          const limitOf = async (taskId: string): Promise<number> => {
            const [row] = await sql<{ n: number }[]>`select e.running_tasks_per_user as n from tasks t join enterprise_memberships e on e.user_id = ${adminOf.get((await sql<{ project_id: string }[]>`select project_id from tasks where id = ${taskId}`)[0]!.project_id)!} where t.id = ${taskId}`;
            return row!.n;
          };
          /**
           * `W` as the gate counts it: the person's waiters under the same limit, judged recently, created earlier.
           * @param taskId - The task about to be picked.
           * @param limit - Its limit.
           * @returns The count.
           */
          const ahead = async (taskId: string, limit: number): Promise<number> => {
            const [row] = await sql<{ n: number }[]>`select count(*)::int as n from tasks w join tasks me on me.id = ${taskId}
              where w.user_id = me.user_id and w.id <> me.id and w.status = 'pending' and w.slot_wait_since is not null and w.slot_wait_limit = ${limit}
                and w.slot_checked_at > now() - ${STALE} * interval '1 millisecond' and w.created_at < me.created_at`;
            return row!.n;
          };

          for (const round of rounds) {
            const pending = await sql<{ id: string }[]>`select id from tasks where id = any(${ids}) and status = 'pending' order by created_at`;
            const batch = pending.slice(0, round.workers).map((r) => r.id);
            const waitingBefore = await sql<{ id: string }[]>`select id from tasks where id = any(${ids}) and status = 'pending' and slot_wait_since is not null order by created_at`;

            if (batch.length === 1) {
              // One pickup: the gate's own arithmetic is checkable exactly (K1, K3).
              const id = batch[0]!;
              const owner = rows.find((r) => r.taskId === id)!.owner;
              const limit = await limitOf(id);
              const r = await inDeadlineRunning(owner);
              const w = await ahead(id, limit);
              const before = await dbNow();
              const got = await pick(id);
              const after = await dbNow();
              if ("started" in got) {
                expect(r + w, `R + W < L for ${id}`).toBeLessThan(limit);
                const t = await taskRow(id);
                between(t.started_at, before, after);
                const node = await nodeRow(rows.find((x) => x.taskId === id)!.nodeTaskId!);
                expect(node.waiting_since).toBeNull();
                // K2: a row that waited starts its node row's budget where the task starts (a node row a fresh
                // task's overdue budget already expired, G-45, stays as it was).
                if (waitingBefore.some((w) => w.id === id) && node.status === "running") expect(node.started_at.getTime()).toBe(t.started_at!.getTime());
              }
              if ("started" in got) {
                expect(startedOnce.has(id)).toBe(false);
                startedOnce.add(id);
              }
            } else if (batch.length > 1) {
              const got = await Promise.all(batch.map((id) => pick(id)));
              got.forEach((g, i) => {
                if (!("started" in g)) return;
                expect(startedOnce.has(batch[i]!)).toBe(false);
                startedOnce.add(batch[i]!);
              });
              // K1 across concurrent pickups: each start had R < its L under the person's lock.
              for (const q of people) {
                const startedHere = batch.filter((id, i) => "started" in got[i]! && rows.find((x) => x.taskId === id)!.owner === q);
                if (startedHere.length === 0) continue;
                const highest = Math.max(...(await Promise.all(startedHere.map((id) => limitOf(id)))));
                expect(await inDeadlineRunning(q)).toBeLessThanOrEqual(highest);
              }
            }

            // The waiters after this round's pickups, with their node rows as they stand now.
            const waitingNodes = await sql<{ id: string; node_status: string }[]>`select t.id, n.status as node_status from tasks t join node_tasks n on n.task_id = t.id
              where t.id = any(${ids}) and t.status = 'pending' and t.slot_wait_since is not null`;
            mayEnd = new Map();
            const pick1 = <T>(list: readonly T[]): T | undefined => (list.length === 0 ? undefined : list[round.pickIndex % list.length]);
            if (round.event === "finish") {
              const done = pick1(await sql<{ id: string }[]>`select id from tasks where id = any(${ids}) and status = 'running' order by started_at`);
              if (done) await sql`update tasks set status = 'completed', completed_at = now() where id = ${done.id}`;
            } else if (round.event === "fail") {
              const victim = pick1(await sql<{ id: string }[]>`select id from tasks where id = any(${ids}) and status in ('pending', 'running') order by created_at`);
              if (victim) {
                mayEnd.set(victim.id, "failed");
                await runningSlotService.failTask(victim.id, "internal");
              }
            } else if (round.event === "cancel") {
              const target = pick1(await sql<{ id: string }[]>`select id from tasks where id = any(${ids}) and status = 'pending' order by created_at`);
              if (target) {
                mayEnd.set(target.id, "cancelled");
                const wasStarted = startedOnce.has(target.id);
                const [cancel, got] = await Promise.all([runningSlotService.cancelQueued(target.id), pick(target.id)]);
                const started = "started" in got;
                // K5: the cancel and the pickup race; exactly one of them takes effect.
                expect(cancel.cancelled && started, `both took effect for ${target.id}`).toBe(false);
                expect(cancel.cancelled || started || "waiting" in got || "ended" in got).toBe(true);
                if (started) {
                  expect(wasStarted).toBe(false);
                  startedOnce.add(target.id);
                }
                if (cancel.cancelled) {
                  expect(cancelledOnce.has(target.id)).toBe(false);
                  cancelledOnce.add(target.id);
                  expect((await taskRow(target.id)).status).toBe("cancelled");
                  // The hold is released in the cancel's own commit.
                  expect((await holdings(target.id)).credit.status).not.toBe("held");
                }
              }
            } else if (round.event === "advance") {
              for (const q of people) await advance(q, round.advanceMs);
            } else if (round.event === "limit") {
              const admin = pick1([...new Set(adminOf.values())])!;
              await sql`update enterprise_memberships set running_tasks_per_user = ${round.limit} where user_id = ${admin}`;
            } else {
              const victim = pick1(waitingBefore);
              if (victim) {
                lost.add(`job-${victim.id}`);
                mayEnd.set(victim.id, "failed");
                // Stale enough for the sweep to look at it.
                await sql`update tasks set slot_checked_at = now() - ${STALE + 1000} * interval '1 millisecond' where id = ${victim.id}`;
              }
            }
            for (const r of rows) await nodeTaskService.harvestAndList({ projectId: r.owner.projectId, nodeId: r.nodeId! });
            await sweepSlotWaiters(queue);

            // K4: a row that waited and never started ends only by this round's cancel, failure or lost job,
            // never as expired.
            for (const { id } of waitingBefore) {
              const t = await taskRow(id);
              if (t.status === "pending" || startedOnce.has(id)) continue;
              // A lost job stays lost: the sweep may end its task in any later round once it is stale again.
              expect(t.status, `waiter ${id} ended as ${t.status}`).toBe(mayEnd.get(id) ?? (lost.has(`job-${id}`) ? "failed" : undefined));
            }
            for (const { id, node_status } of waitingNodes) {
              if ((await taskRow(id)).status !== "pending") continue;
              // A row still waiting keeps its node row as it was (a fresh task's overdue row may already have
              // expired, G-45) and its hold valid (K2, K4).
              expect((await nodeRow(rows.find((x) => x.taskId === id)!.nodeTaskId!)).status).toBe(node_status);
              expect((await holdings(id)).credit.status).toBe("held");
            }
          }
        },
      ),
      { numRuns: 100 },
    );
    // A hundred runs of up to ten rows and eight rounds, each round harvesting every node: the slowest case of
    // this suite, many times its time alone beside every other suite.
  }, 600_000);
});
