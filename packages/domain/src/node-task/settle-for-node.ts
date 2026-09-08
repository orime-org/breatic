// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Settling one node's row of a generation (#186, design §3.6).
 *
 * The worker knows which job it is running and which node it just wrote, and
 * that pair names exactly one row: a run writing several nodes opened one on
 * each, all carrying the same job id.
 *
 * Every generation announces its outcome through here, so the recount and the
 * event it publishes are written once. An upload's row settles elsewhere: no
 * job is paired with it, so `video-cover-job.ts` finds it by storage key once
 * the cover step is done.
 */

import type { getStreamRedis } from "@breatic/core";
import type { NodeTaskResult } from "@breatic/shared";
import * as repo from "@domain/node-task/node-task.repo.js";
import * as service from "@domain/node-task/node-task.service.js";
import { emitNodeTaskCounts } from "@domain/canvas-node/node-state-events.js";

/**
 * Move one node's row to a terminal state and publish that node's counts.
 *
 * A node this run opened no row on is left alone: a run whose result node the
 * browser creates has no row, and neither does anything that predates this
 * table.
 * @param streamRedis - Redis client for the stream DB.
 * @param docName - Canvas doc the node lives in.
 * @param opts - Which job, which node, and how it went.
 * @param opts.taskId - The job every row of this run points at.
 * @param opts.nodeId - The node just written to.
 * @param opts.outcome - Where the row lands.
 * @param opts.nodeHistoryId - The history row holding the result.
 * @param opts.errorMessage - What the list shows for a failure.
 * @param opts.result - The content fields, on the transition into `done`.
 */
export async function settleTaskForNode(
  streamRedis: ReturnType<typeof getStreamRedis>,
  docName: string,
  opts: {
    taskId: string;
    nodeId: string;
    outcome: "done" | "failed" | "expired";
    nodeHistoryId?: string;
    errorMessage?: string;
    result?: NodeTaskResult;
  },
): Promise<void> {
  const row = await repo.findByTaskAndNode(opts.taskId, opts.nodeId);
  if (row === null) return;

  const settled = await service.settle({
    taskId: row.id,
    outcome: opts.outcome,
    ...(opts.nodeHistoryId !== undefined && {
      nodeHistoryId: opts.nodeHistoryId,
    }),
    ...(opts.errorMessage !== undefined && { errorMessage: opts.errorMessage }),
  });

  await emitNodeTaskCounts(
    streamRedis,
    docName,
    opts.nodeId,
    settled.counts,
    // The content rides along whenever the row holds this outcome, including
    // a report repeated because the first one was not heard. A row that
    // settled some OTHER way keeps whatever is on the node: something else
    // finished it, and choosing between the two is not ours to do.
    settled.landed ? opts.result : undefined,
  );
}
