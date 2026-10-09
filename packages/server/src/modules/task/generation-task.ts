// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { getNodeTaskConfig, AppError, logger } from "@breatic/core";
import { canvasSpaceDocName } from "@breatic/shared";
import { nodeTaskService, taskService } from "@breatic/domain";
import { precheckCredits } from "@server/modules/payment/credit-precheck.service.js";
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
 * a refusal that also loses its broadcast is still a refusal, and the reader
 * sees it on the next read of the list.
 * @param projectId - Owning project.
 * @param spaceId - The space, so an event can name the document.
 * @param rows - What `openGenerationTasks` opened.
 * @param reason - The stored failure code the reader is told in their own language.
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
 * Start a run whose result nodes are already on the canvas: open their rows,
 * check the credits, queue the job and keep its id. The rows open before the
 * credit check so a refusal is said where the node can show it.
 *
 * Once a row is open, any failure settles both accounts of the run — the task
 * and its rows — each on its own, so neither settlement takes the other down:
 * a task left `pending` is one no worker picks up and no sweep ends, and a row
 * left `running` counts a run that is not happening. `no_credits` is the one
 * cause the reader can act on; anything else is ours, and the log carries it.
 * @param opts - The run.
 * @param opts.taskId - The task this run belongs to.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The space the result nodes are in.
 * @param opts.nodeIds - The result nodes the browser built.
 * @param opts.userId - Who started it.
 * @param opts.action - What the rows say this run is.
 * @param opts.label - What the rows name it by.
 * @param opts.credits - The credits the run is checked against.
 * @param opts.enqueue - Queues the job, past the point of no return.
 * @param opts.logTag - Prefix of this lane's log events.
 * @param opts.logContext - Extra fields on the failure log.
 * @returns `"pending"` once queued, `"failed"` when refused after a row opened.
 * @throws {Error} The refusal itself, when no row opened to carry it.
 */
export async function startRowedRun(opts: {
  taskId: string;
  projectId: string;
  spaceId: string;
  nodeIds: string[];
  userId: string;
  action: Exclude<NodeTaskAction, "upload">;
  label: string;
  credits: () => Promise<number>;
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
    await precheckCredits(projectId, opts.userId, await opts.credits());
    const job = await opts.enqueue();
    // Queueing is the point of no return: the job runs whether or not its id
    // is kept. The id is for whoever has to find the job in the queue by hand.
    try {
      await taskService.setJobId(taskId, job.id ?? "");
    } catch (err) {
      logger.error({ err, taskId, jobId: job.id, projectId }, `${opts.logTag}_job_id_not_recorded`);
    }
    return "pending";
  } catch (err) {
    const reason: TaskFailureReason = err instanceof AppError && err.statusCode === 402 ? "no_credits" : "internal";
    for (const settle of [
      (): Promise<unknown> => taskService.markFailed(taskId, reason),
      (): Promise<unknown> => failOpenedTasks(projectId, spaceId, rows, reason),
    ]) {
      try {
        await settle();
      } catch (settleErr) {
        logger.error({ err: settleErr, taskId, projectId }, `${opts.logTag}_run_settle_failed`);
      }
    }
    logger.warn({ err, taskId, projectId, reason, ...opts.logContext }, `${opts.logTag}_run_failed`);
    // An open row is the answer — it holds the cause and the node shows it.
    // With none, opening it is what failed, and the rejection carries the cause.
    if (rows.length > 0) return "failed";
    throw err;
  }
}
