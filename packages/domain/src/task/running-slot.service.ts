// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How many tasks one person may run at once (inner#1968, design 3.9).
 *
 * The worker asks {@link startWithinLimit} before a task first runs and
 * {@link claimWithinLimit} before a Timeline execution does. Under the person's `running-tasks:<user_id>` advisory
 * lock it counts what they run within the budget and the report grace (`R`)
 * and the earlier waiters under the same limit that were judged recently
 * (`W`): `R + W` below the limit of the studio the task runs in starts it,
 * anything else makes it wait, and the caller puts the job back on the queue.
 * A pickup that cannot take the lock within `slot_lock_wait_ms` writes nothing
 * and comes back after one poll. Cancelling a task that has not started and
 * ending one for good take the same lock, so a start, a cancel and a cleanup of
 * one person's tasks happen one at a time.
 */

import {
  db,
  getMembershipReadingForUser,
  getNodeTaskConfig,
  getStreamRedis,
  getWorkerConfig,
  projectsRepo,
  publishSpaceTasksChanged,
  reportGraceMs,
  timelineReportGraceMs,
  runningTaskLimitForStudio,
  runningTasksPerUserOf,
  timelineExecutionRepo,
  type DbTx,
} from "@breatic/core";
import { canvasSpaceDocName, type TaskFailureReason, type TimelineExecution } from "@breatic/shared";
import * as taskRepo from "@domain/task/task.repo.js";
import * as nodeTaskRepo from "@domain/node-task/node-task.repo.js";
import * as nodeTaskService from "@domain/node-task/node-task.service.js";
import * as sceneTaskService from "@domain/node-task/scene-task.service.js";
import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import { emitNodeTaskCounts } from "@domain/canvas-node/node-state-events.js";
import { StillRunning } from "@domain/task/still-running.js";

import type { NodeTaskCounts, TaskRowPlace } from "@domain/node-task/node-task.repo.js";

/**
 * What the gate came to when the row does not wait. `started` carries what
 * the start gave this pickup: a task's start, or a Timeline execution as its
 * claim wrote it.
 */
export type GateOutcome<S> =
  | { outcome: "started"; started: S; publishFailures: unknown[] }
  | {
      /** It reached its end before this pickup, or (a Timeline execution) another pickup holds it. */
      outcome: "ended";
      /** On a task the old code failed and left open: true once its holdings and rows are closed here. */
      failed?: boolean;
      /** Signals to the canvas that did not go out, for the caller to log. */
      publishFailures: unknown[];
    };

/** What one judgement under the lock came to. */
type Judged<S> =
  | { kind: "busy" }
  | { kind: "ended" }
  | { kind: "started"; started: S; places: TaskRowPlace[]; space: boolean }
  | { kind: "waiting"; delayMs: number; places: TaskRowPlace[]; space: boolean };

/**
 * Wait a moment.
 * @param ms - How long.
 * @returns Resolves after it.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Take the person's gate lock, trying for `slot_lock_wait_ms`: another pickup
 * of theirs holds it only while it counts.
 * @param userId - The person.
 * @param tx - The gate's transaction.
 * @returns Whether it was taken.
 */
async function takeLock(userId: string, tx: DbTx): Promise<boolean> {
  const until = Date.now() + getWorkerConfig().slot_lock_wait_ms;
  for (;;) {
    if (await taskRepo.tryLockRunningSlots(userId, tx)) return true;
    if (Date.now() >= until) return false;
    await pause(20);
  }
}

/**
 * The running-task limit for work in a project: that studio's, or the
 * person's own when the work has no project or its project is gone
 * (design 3.9).
 * @param projectId - The project, if any.
 * @param userId - Who runs it.
 * @returns The limit.
 * @throws {Error} When the membership cannot be read; the worker logs it and retries the job.
 */
async function limitFor(projectId: string | null, userId: string): Promise<number> {
  const studioId = projectId === null ? undefined : await projectsRepo.findOwnerStudioId(projectId);
  if (studioId !== undefined) return runningTaskLimitForStudio(studioId);
  return runningTasksPerUserOf(await getMembershipReadingForUser(userId));
}

/**
 * What the person runs, and how many wait ahead of a row under its limit.
 * @param userId - The person.
 * @param limit - The row's limit.
 * @param createdAt - The row's creation, full-precision text.
 * @param tx - The gate's transaction, holding the person's lock.
 * @returns `R` and `W`.
 */
async function standing(userId: string, limit: number, createdAt: string, tx: DbTx): Promise<{ running: number; ahead: number }> {
  const stale = getWorkerConfig().slot_wait_stale_ms;
  const running = (await taskRepo.countRunningForUser(userId, getNodeTaskConfig().default_budget_ms + reportGraceMs(), tx))
    + (await timelineExecutionRepo.countRunningForActor(userId, timelineReportGraceMs(), tx));
  const ahead = (await taskRepo.countWaitingBefore(userId, limit, createdAt, stale, tx))
    + (await timelineExecutionRepo.countWaitingBefore(userId, limit, createdAt, stale, tx));
  return { running, ahead };
}

/**
 * How long a waiter stays away: a poll for each place it stands behind the
 * first one a free slot would start, capped.
 * @param limit - `L`.
 * @param running - `R`.
 * @param ahead - `W`.
 * @returns The delay in milliseconds.
 */
function waitDelay(limit: number, running: number, ahead: number): number {
  const { poll_interval: poll, slot_wait_max_delay_ms: cap } = getWorkerConfig();
  return Math.min(poll * Math.max(1, ahead - (limit - running) + 1), cap);
}

/**
 * Keep a task's credit hold alive to now + budget + grace. While the task
 * waits the hold is renewed only once it has less than half the budget left;
 * a start renews it whatever is left.
 * @param creditHold - The credit hold's key.
 * @param always - Renew whatever is left.
 * @param tx - The gate's transaction.
 */
async function renewHoldings(creditHold: string, always: boolean, tx: DbTx): Promise<void> {
  const budget = getNodeTaskConfig().default_budget_ms;
  const now = Date.now();
  const until = new Date(now + budget + reportGraceMs());
  const dueBefore = always ? until : new Date(now + budget / 2);
  await creditHoldRepo.extendHold(creditHold, until, tx, dueBefore);
}

/**
 * Tell the canvas that rows changed: each node's counts, and the Space's list
 * for a 3D Space's own row or a Timeline execution.
 * @param places - The node task rows that changed.
 * @param space - A Space whose list changed, beside those rows.
 * @returns The signals that failed.
 */
async function publish(places: readonly TaskRowPlace[], space: { projectId: string; spaceId: string } | null): Promise<unknown[]> {
  const sends: Promise<void>[] = places.map(async (place) => {
    if (place.nodeId === null) return publishSpaceTasksChanged(place.projectId, place.spaceId);
    const counts = await nodeTaskRepo.countsFor(place.projectId, place.nodeId);
    return emitNodeTaskCounts(getStreamRedis(), canvasSpaceDocName(place.projectId, place.spaceId), place.nodeId, counts, undefined);
  });
  if (space !== null) sends.push(publishSpaceTasksChanged(space.projectId, space.spaceId));
  return (await Promise.allSettled(sends)).flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
}

/**
 * Settle every row of a task still running as failed and tell the canvas.
 * @param taskId - The task.
 * @param errorMessage - What a node's rows show.
 * @param sceneReason - What a 3D Space's own row shows: always one of our codes, which each member reads in their
 *   own language.
 * @returns Each settled node's counts, by node id, and the signals that failed.
 */
async function failRows(taskId: string, errorMessage: string, sceneReason: TaskFailureReason): Promise<{ counts: Map<string, NodeTaskCounts>; publishFailures: unknown[] }> {
  const failures: unknown[] = [];
  const counts = new Map<string, NodeTaskCounts>();
  for (const place of await nodeTaskRepo.listRunningForTask(taskId)) {
    if (place.nodeId === null) {
      await sceneTaskService.settleById(place.id, { outcome: "failed", errorMessage: sceneReason });
      failures.push(...(await publish([], { projectId: place.projectId, spaceId: place.spaceId })));
      continue;
    }
    const settled = await nodeTaskService.settle({ taskId: place.id, outcome: "failed", errorMessage });
    counts.set(place.nodeId, settled.counts);
    try {
      await emitNodeTaskCounts(getStreamRedis(), canvasSpaceDocName(place.projectId, place.spaceId), place.nodeId, settled.counts, undefined);
    } catch (err) {
      failures.push(err);
    }
  }
  return { counts, publishFailures: failures };
}

/**
 * Judge a pending task under the person's lock.
 * @param row - The task.
 * @param jobId - The job picking it up.
 * @param limit - Its limit.
 * @returns What the judgement came to; a start carries the task's start.
 */
async function judgeTask(row: taskRepo.GateTaskRow, jobId: string, limit: number): Promise<Judged<Date>> {
  return db.transaction(async (tx): Promise<Judged<Date>> => {
    if (!(await takeLock(row.userId, tx))) return { kind: "busy" };
    const { running, ahead } = await standing(row.userId, limit, row.createdAt, tx);
    if (running + ahead < limit) {
      const startedAt = await taskRepo.startPending(row.id, jobId, tx);
      if (startedAt === null) return { kind: "ended" };
      const places = row.slotWaitSince === null ? [] : await nodeTaskRepo.startWaiting(row.id, tx);
      await renewHoldings(row.id, true, tx);
      return { kind: "started", started: startedAt, places, space: false };
    }
    await taskRepo.markSlotWait(row.id, jobId, tx);
    await taskRepo.noteSlotCheck(row.id, limit, getWorkerConfig().slot_wait_stale_ms, tx);
    const places = await nodeTaskRepo.markWaiting(row.id, tx);
    await renewHoldings(row.id, false, tx);
    return { kind: "waiting", delayMs: waitDelay(limit, running, ahead), places, space: false };
  });
}

/**
 * Judge a queued Timeline execution under the person's lock.
 * @param row - The execution.
 * @param row.id - Its id.
 * @param row.actorUserId - Who runs it.
 * @param row.createdAt - Its creation, full-precision text.
 * @param limit - Its limit.
 * @returns What the judgement came to; a start carries the execution as the claim wrote it.
 */
async function judgeExecution(row: { id: string; actorUserId: string; createdAt: string }, limit: number): Promise<Judged<TimelineExecution>> {
  return db.transaction(async (tx): Promise<Judged<TimelineExecution>> => {
    if (!(await takeLock(row.actorUserId, tx))) return { kind: "busy" };
    const { running, ahead } = await standing(row.actorUserId, limit, row.createdAt, tx);
    if (running + ahead < limit) {
      const budgetMs = getNodeTaskConfig().default_budget_ms;
      const claimed = await timelineExecutionRepo.transition({ id: row.id, event: { type: "claim", budgetMs } }, tx);
      if (!claimed.applied) return { kind: "ended" };
      return { kind: "started", started: claimed.row, places: [], space: true };
    }
    const first = await timelineExecutionRepo.markSlotWait(row.id, tx);
    await timelineExecutionRepo.noteSlotCheck(row.id, limit, getWorkerConfig().slot_wait_stale_ms, tx);
    return { kind: "waiting", delayMs: waitDelay(limit, running, ahead), places: [], space: first };
  });
}

/**
 * Close what a task the old code failed left open (design 3.9, round 7 W3):
 * its credit hold and its running node rows. Each step is a no-op on
 * a task already closed.
 * @param row - The task.
 * @returns The signals that failed.
 */
async function closeFailed(row: taskRepo.GateTaskRow): Promise<unknown[]> {
  await creditHoldRepo.releaseHold(row.id);
  return (await failRows(row.id, row.errorMessage ?? "internal", "internal")).publishFailures;
}

/**
 * Start a task nobody has run yet when its person runs fewer tasks than its
 * limit allows, or make it wait.
 * @param input - The task and the job picking it up.
 * @param input.id - The task.
 * @param input.jobId - The job, written on the task it starts.
 * @returns `started` with its start when it runs now or already ran, `ended` when it already reached its end.
 * @throws {StillRunning} When it waits: the caller puts the job back until `resumeAt`.
 * @throws {Error} When the task does not exist or runs without a start, or a read or write fails.
 */
export async function startWithinLimit(input: { id: string; jobId: string }): Promise<GateOutcome<Date>> {
  const row = await taskRepo.findForGate(input.id);
  if (row === null) throw new Error(`task ${input.id} does not exist`);
  if (row.status === "running") {
    if (row.startedAt === null) throw new Error(`running task ${row.id} has no start`);
    return { outcome: "started", started: row.startedAt, publishFailures: [] };
  }
  if (row.status === "failed") return { outcome: "ended", failed: true, publishFailures: await closeFailed(row) };
  if (row.status !== "pending") return { outcome: "ended", publishFailures: [] };
  const judged = await judgeTask(row, input.jobId, await limitFor(row.projectId, row.userId));
  return settleJudgement(judged, null);
}

/**
 * Claim a queued Timeline execution when its person runs fewer tasks than its
 * limit allows, or make it wait. Only a queued row is judged: one in any other
 * state answers `ended`, and the caller reads it again and handles it as it
 * stands, so a pickup never runs under another pickup's claim.
 * @param executionId - The execution.
 * @returns `started` with the execution as this claim wrote it, `ended` when it is not queued.
 * @throws {StillRunning} When it waits: the caller puts the job back until `resumeAt`.
 * @throws {Error} When the execution does not exist, or a read or write fails.
 */
export async function claimWithinLimit(executionId: string): Promise<GateOutcome<TimelineExecution>> {
  const row = await timelineExecutionRepo.findById(executionId);
  if (row === undefined) throw new Error(`Timeline execution ${executionId} does not exist`);
  if (row.status !== "queued") return { outcome: "ended", publishFailures: [] };
  const judged = await judgeExecution(row, await limitFor(row.projectId, row.actorUserId));
  return settleJudgement(judged, { projectId: row.projectId, spaceId: row.spaceId });
}

/**
 * Signal what the judgement changed, then answer it.
 * @param judged - The judgement.
 * @param space - The Space whose list a Timeline execution sits in.
 * @returns The outcome when the row does not wait.
 * @throws {StillRunning} When it waits.
 */
async function settleJudgement<S>(judged: Judged<S>, space: { projectId: string; spaceId: string } | null): Promise<GateOutcome<S>> {
  if (judged.kind === "busy") throw new StillRunning(Date.now() + getWorkerConfig().poll_interval);
  if (judged.kind === "ended") return { outcome: "ended", publishFailures: [] };
  const failures = await publish(judged.places, judged.space ? space : null);
  if (judged.kind === "waiting") throw new StillRunning(Date.now() + judged.delayMs, failures);
  return { outcome: "started", started: judged.started, publishFailures: failures };
}

/** What cancelling came to. */
export interface CancelOutcome {
  /** False when the task had started or ended already. */
  cancelled: boolean;
  /** Each node's counts after it, by node id; a 3D Space's own row has none. */
  counts: Map<string, NodeTaskCounts>;
  /** Signals to the canvas that did not go out, for the caller to log. */
  publishFailures: unknown[];
}

/**
 * Cancel a task that has not started (design 3.9): the task and its credit
 * hold in one commit under the person's lock, then its rows
 * end as failed with the reason `cancelled`.
 * @param taskId - The task.
 * @returns Whether it was cancelled, and each of its nodes' counts.
 * @throws {Error} When the task does not exist, or a write fails.
 */
export async function cancelQueued(taskId: string): Promise<CancelOutcome> {
  const row = await taskRepo.findForGate(taskId);
  if (row === null) throw new Error(`task ${taskId} does not exist`);
  const cancelled = await db.transaction(async (tx) => {
    await taskRepo.lockRunningSlots(row.userId, tx);
    if (!(await taskRepo.cancelPending(taskId, tx))) return false;
    await creditHoldRepo.releaseHold(taskId, tx);
    return true;
  });
  if (!cancelled) return { cancelled: false, counts: new Map(), publishFailures: [] };
  return { cancelled: true, ...(await failRows(taskId, "cancelled", "cancelled")) };
}

/**
 * End a task for good, waiting or running (design 3.9, failure cleanup and
 * the stale-waiter sweep): the task fails and its credit hold is released
 * in one commit under the person's lock, then its open rows end as failed.
 * @param taskId - The task.
 * @param errorMessage - What the task and its nodes' rows show; a 3D Space's own row shows `internal`.
 * @returns Whether this call failed the task, and the signals that failed.
 * @throws {Error} When a write fails.
 */
export async function failTask(taskId: string, errorMessage: string): Promise<{ failed: boolean; publishFailures: unknown[] }> {
  const row = await taskRepo.findForGate(taskId);
  if (row === null) return { failed: false, publishFailures: [] };
  const failed = await db.transaction(async (tx) => {
    await taskRepo.lockRunningSlots(row.userId, tx);
    const moved = await taskRepo.failOpen(taskId, errorMessage, tx);
    await creditHoldRepo.releaseHold(taskId, tx);
    return moved;
  });
  return { failed, publishFailures: (await failRows(taskId, errorMessage, "internal")).publishFailures };
}

/**
 * Waiting tasks the gate has not judged within the stale window.
 * @param limit - How many at most.
 * @returns Each task, its owner and its job.
 */
export async function staleWaiters(limit: number): Promise<Array<{ id: string; userId: string; arqJobId: string }>> {
  return taskRepo.listStaleWaiters(getWorkerConfig().slot_wait_stale_ms, limit);
}
