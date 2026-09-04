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

import { getStreamRedis, getNodeTaskConfig } from "@breatic/core";
import { canvasSpaceDocName } from "@breatic/shared";
import { nodeTaskService, emitNodeTaskCounts } from "@breatic/domain";
import { logger } from "@breatic/core";

/**
 * Open one running row per target node and publish each node's counts.
 *
 * A node whose row cannot be opened is logged and skipped: the job is already
 * on its way and the other nodes in this run are still going to be written
 * to, so a node without a row shows no count rather than stopping the run.
 * @param opts - Where the run writes, who started it, and what it is.
 * @param opts.projectId - Owning project.
 * @param opts.spaceId - The space, so an event can name the document.
 * @param opts.nodeIds - The nodes this run will write to.
 * @param opts.startedByUserId - Who started it.
 * @param opts.taskId - The job every row points at.
 * @param opts.label - What the user reads in the list — the model or tool.
 */
export async function openGenerationTasks(opts: {
  projectId: string;
  spaceId: string;
  nodeIds: string[];
  startedByUserId: string;
  taskId: string;
  label: string;
}): Promise<void> {
  const budgetMs = getNodeTaskConfig().default_budget_ms;
  const docName = canvasSpaceDocName(opts.projectId, opts.spaceId);

  for (const nodeId of opts.nodeIds) {
    try {
      const opened = await nodeTaskService.open({
        projectId: opts.projectId,
        spaceId: opts.spaceId,
        nodeId,
        kind: "generation",
        startedByUserId: opts.startedByUserId,
        budgetMs,
        label: opts.label,
        taskId: opts.taskId,
      });
      await emitNodeTaskCounts(
        getStreamRedis(),
        docName,
        nodeId,
        opened.counts,
      );
    } catch (err) {
      logger.error(
        { err, nodeId, taskId: opts.taskId, projectId: opts.projectId },
        "node_task_open_failed",
      );
    }
  }
}
