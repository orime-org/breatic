// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The task rows a generation leaves on the nodes it will write to (#186).
 *
 * A generation and a mini-tool reach this the same way: the caller named the
 * nodes its result lands on, and each of those gets a row of its own carrying
 * the shared job id. That is what lets a node show several tasks at once, and
 * what lets the worker settle exactly the row for the node it just wrote.
 *
 * The budget comes from configuration and from nowhere else. A deadline is
 * the sole basis on which a task is judged dead, so taking it from whoever
 * started the task would let them decide when their own work stops counting
 * as alive.
 */

import { randomUUID } from "node:crypto";
import { getNodeTaskConfig, AppError, logger } from "@breatic/core";
import { canvasSpaceDocName } from "@breatic/shared";
import { creditHoldService, nodeTaskService, taskService } from "@breatic/domain";
import { reserveForRun } from "@server/modules/payment/credit-precheck.service.js";
import { assertAccess } from "@server/modules/project/project.service.js";
import { publishCountsQuietly } from "@server/modules/task/publish-counts.js";
import { t } from "@breatic/shared";
import type { NodeTaskAction, TaskFailureReason } from "@breatic/shared";

/** One row this request opened, for a caller that may have to settle it. */
export interface OpenedTaskRow {
  /** The node the row sits on. */
  nodeId: string;
  /** The row itself, which is what `settle` names. */
  rowId: string;
}

/**
 * Open one running row per target node and publish each node's counts.
 *
 * Called before the job is enqueued, and refuses the request when a row
 * cannot be opened (design §4.6.5). The row is the only path a result takes
 * back to its node: the worker settles it and that settle is what carries the
 * content, so a run whose row is missing bills the user for a result nothing
 * can deliver, so it is refused before anything is charged.
 * @param opts - Where the run writes, who started it, and what it is.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The space, so an event can name the document.
 * @param opts.nodeIds - The nodes this run will write to.
 * @param opts.startedByUserId - Who started it.
 * @param opts.taskId - The job every row points at.
 * @param opts.action - What the rows' first line names.
 * @param opts.label - What the user reads in the list — the model or tool id.
 * @returns The rows opened, for a caller that may still have to settle them.
 * @throws {AppError} 503 when a row cannot be opened.
 */
export async function openGenerationTasks(opts: {
  projectId: string;
  spaceId: string;
  nodeIds: string[];
  startedByUserId: string;
  taskId: string;
  action: Exclude<NodeTaskAction, "upload">;
  label: string;
}): Promise<OpenedTaskRow[]> {
  const budgetMs = getNodeTaskConfig().default_budget_ms;
  const docName = canvasSpaceDocName(opts.projectId, opts.spaceId);
  const rows: OpenedTaskRow[] = [];

  for (const nodeId of opts.nodeIds) {
    let opened;
    try {
      opened = await nodeTaskService.open({
        projectId: opts.projectId,
        spaceId: opts.spaceId,
        nodeId,
        kind: "generation",
        action: opts.action,
        startedByUserId: opts.startedByUserId,
        budgetMs,
        label: opts.label,
        taskId: opts.taskId,
      });
    } catch (err) {
      logger.error(
        { err, nodeId, taskId: opts.taskId, projectId: opts.projectId },
        "node_task_open_failed",
      );
      // The rows already open belong to a run that is not happening; left
      // running they would count it until the two-hour harvest.
      await failOpenedTasks(opts.projectId, opts.spaceId, rows, "internal").catch((settleErr: unknown) => {
        logger.error({ err: settleErr, taskId: opts.taskId, projectId: opts.projectId }, "node_task_open_cleanup_failed");
      });
      throw new AppError(503, t("canvas.task.couldNotStart"));
    }
    await publishCountsQuietly(docName, nodeId, opened.counts);
    rows.push({ nodeId, rowId: opened.id });
  }
  return rows;
}

/**
 * Settle rows this request opened as failed, for a run it then refused.
 *
 * The node was on the canvas before the request went out, so the refusal is
 * said where the node can show it: the row settles `failed` carrying the
 * cause, and the node's count moves with it (downstream-node-creation
 * decision, stage 4). Publishing is quiet for the same reason opening it is —
 * a refusal that also loses its broadcast is still a refusal, and the user
 * sees it on the next read of the list.
 * @param projectId - Owning project.
 * @param spaceId - The space, so an event can name the document.
 * @param rows - What `openGenerationTasks` opened.
 * @param reason - The stored failure code the user is told in their own language.
 */
export async function failOpenedTasks(
  projectId: string,
  spaceId: string,
  rows: readonly OpenedTaskRow[],
  reason: TaskFailureReason,
): Promise<void> {
  const docName = canvasSpaceDocName(projectId, spaceId);
  for (const row of rows) {
    const settled = await nodeTaskService.settle({
      taskId: row.rowId,
      outcome: "failed",
      errorMessage: reason,
    });
    await publishCountsQuietly(docName, row.nodeId, settled.counts);
  }
}

/**
 * Hold a rowed run's estimate under the id its task row will carry, then
 * write that row (inner#1968, design 3.10): a refusal, by the balance or by a
 * monthly spend limit, leaves no task row and no node row behind, the same
 * order the canvas generation takes. Every way out releases what was held;
 * once the row exists, {@link startRowedRun} settles the run.
 * @param opts - The run.
 * @param opts.taskId - The id the task row takes.
 * @param opts.projectId - Owning project.
 * @param opts.userId - Who started it.
 * @param opts.credits - The run's estimate.
 * @param opts.create - Writes the task row.
 * @returns The task row.
 * @throws {SpendCapReachedError} 402 when a monthly spend limit cannot take the estimate.
 * @throws {AppError} 402 when the studio cannot cover the estimate; whatever writing the row throws.
 */
export async function holdRowedRun<T>(opts: {
  taskId: string;
  projectId: string;
  userId: string;
  credits: () => Promise<number>;
  create: () => Promise<T>;
}): Promise<T> {
  try {
    await reserveForRun(opts.projectId, opts.userId, opts.taskId, await opts.credits());
    return await opts.create();
  } catch (err) {
    // A refused admission held nothing, and releasing it does nothing.
    await creditHoldService.releaseHold(opts.taskId);
    throw err;
  }
}

/**
 * Start a run whose result nodes are already on the canvas and whose credits
 * {@link holdRowedRun} already holds: open their rows, queue the job and keep
 * its id. The hold comes before any row, so a refusal opens none (inner#1968,
 * design 3.10 U9).
 *
 * Once a row is open, any failure settles both accounts of the run — the task
 * and its rows — each on its own, so neither settlement takes the other down:
 * a task left `pending` is one no worker picks up and no sweep ends, and a row
 * left `running` counts a run that is not happening. The cause is ours, and
 * the log carries it.
 * @param opts - The run.
 * @param opts.taskId - The task this run belongs to.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The space the result nodes are in.
 * @param opts.nodeIds - The result nodes the browser built.
 * @param opts.userId - Who started it.
 * @param opts.action - What the rows say this run is.
 * @param opts.label - What the rows name it by.
 * @param opts.enqueue - Queues the job, past the point of no return.
 * @param opts.logTag - Prefix of this lane's log events.
 * @param opts.logContext - Extra fields on the failure log.
 * @returns `"pending"` once queued, `"failed"` when it failed after a row opened.
 * @throws {Error} The failure itself, when no row opened to carry it.
 */
export async function startRowedRun(opts: {
  taskId: string;
  projectId: string;
  spaceId: string;
  nodeIds: string[];
  userId: string;
  action: Exclude<NodeTaskAction, "upload">;
  label: string;
  enqueue: () => Promise<{ id?: string | undefined }>;
  logTag: string;
  logContext?: Record<string, unknown>;
}): Promise<"pending" | "failed"> {
  const { taskId, projectId, spaceId } = opts;
  let rows: OpenedTaskRow[] = [];
  try {
    rows = await openGenerationTasks({
      projectId,
      spaceId,
      nodeIds: opts.nodeIds,
      startedByUserId: opts.userId,
      taskId,
      action: opts.action,
      label: opts.label,
    });
    const job = await opts.enqueue();
    await recordJobId(taskId, job.id, projectId, opts.logTag);
    return "pending";
  } catch (err) {
    const reason: TaskFailureReason = "internal";
    await settleUnqueuedRun(taskId, projectId, reason, () => failOpenedTasks(projectId, spaceId, rows, reason), opts.logTag);
    logger.warn({ err, taskId, projectId, reason, ...opts.logContext }, `${opts.logTag}_run_failed`);
    // An open row is the answer — it holds the cause and the node shows it.
    // With none, opening it is what failed, and the rejection carries the cause.
    if (rows.length > 0) return "failed";
    throw err;
  }
}

/**
 * Admit a generation up to its hold, the first steps a Canvas generation and a
 * 3D Space generation share (inner#1691 design 4.2 steps 1 to 5): the caller
 * may edit the project, the submission passes the caller's checks, and the
 * estimate is held under the id its task row will carry, before that row
 * exists, so a refusal leaves nothing behind. From here until the job is
 * queued, every way out releases the hold; once queued, the worker charges or
 * releases it.
 * @param opts - The submission.
 * @param opts.projectId - The project it runs in.
 * @param opts.userId - Who submits it.
 * @param opts.check - The submission's own checks; throws its refusal, returns what the estimate reads.
 * @param opts.credits - The run's estimate, from what the checks returned.
 * @returns The new task id, and what the checks returned.
 * @throws {AppError} 403 or 404 without editor access, the checks' refusal, 402 when the studio cannot cover the estimate.
 */
export async function holdRun<T>(opts: {
  projectId: string;
  userId: string;
  check: () => Promise<T>;
  credits: (checked: T) => Promise<number>;
}): Promise<{ taskId: string; checked: T }> {
  await assertAccess(opts.projectId, opts.userId, "editor");
  const checked = await opts.check();
  const taskId = randomUUID();
  await reserveForRun(opts.projectId, opts.userId, taskId, await opts.credits(checked));
  return { taskId, checked };
}

/**
 * End a run that failed before its job was queued: release its hold, fail its
 * task, then settle its own row. Each step runs whatever the others did, so
 * neither account of the run takes the other down: a task left `pending` is
 * one no worker picks up and no sweep ends, and a row left `running` counts a
 * run that is not happening.
 * @param taskId - The run.
 * @param projectId - Owning project, for the log.
 * @param reason - Why the task failed.
 * @param settleRow - Settles the run's own row or rows.
 * @param logTag - Prefix of this lane's log events.
 * @throws {never} Each failure only logs.
 */
export async function settleUnqueuedRun(
  taskId: string,
  projectId: string,
  reason: TaskFailureReason,
  settleRow: () => Promise<unknown>,
  logTag: string,
): Promise<void> {
  for (const settle of [
    // A refused admission held nothing, and releasing it does nothing.
    (): Promise<unknown> => creditHoldService.releaseHold(taskId),
    (): Promise<unknown> => taskService.markFailed(taskId, reason),
    settleRow,
  ]) {
    try {
      await settle();
    } catch (settleErr) {
      logger.error({ err: settleErr, taskId, projectId }, `${logTag}_run_settle_failed`);
    }
  }
}

/**
 * Keep a queued job's id on its task. Queueing is the point of no return: the
 * job runs whether or not its id is kept, which is for whoever has to find the
 * job in the queue by hand, so a failure here only logs.
 * @param taskId - The run.
 * @param jobId - The queue's id for its job.
 * @param projectId - Owning project, for the log.
 * @param logTag - Prefix of this lane's log events.
 * @throws {never} A failure only logs.
 */
export async function recordJobId(taskId: string, jobId: string | undefined, projectId: string, logTag: string): Promise<void> {
  try {
    await taskService.setJobId(taskId, jobId ?? "");
  } catch (err) {
    logger.error({ err, taskId, jobId, projectId }, `${logTag}_job_id_not_recorded`);
  }
}
