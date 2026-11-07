// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Timeline sweep (inner#1711 design §5.2), run on a schedule over executions that have not ended.
 *
 * An awaiting-landing row past its original deadline expires; a deleted Space gets no handling of its own, as with
 * canvas tasks. A queued row whose dispatch time has come, and every running or cancelling row, must have a live job
 * under its execution id: a missing, failed or completed job is removed and added again, because the queue's
 * retention would otherwise keep the old job id occupied. Nothing here calls the ingest Worker.
 */

import type { Queue } from "bullmq";
import { addTimelineExecutionJob, getTimelineConfig, logger, timelineExecutionRepo } from "@breatic/core";
import { move } from "@worker/handlers/timeline/timeline-transition.js";

/** Job states that no longer run the execution. */
const FINISHED = new Set(["completed", "failed", "unknown"]);

/**
 * Make sure an execution has a live job: leave one that waits or runs, replace one that finished.
 * @param queue - The `timeline` queue.
 * @param executionId - The execution.
 * @returns Nothing once it has one.
 * @throws {Error} When Redis refuses.
 */
async function ensureJob(queue: Pick<Queue, "add" | "getJob">, executionId: string): Promise<void> {
  const job = await queue.getJob(executionId);
  if (job !== undefined) {
    if (!FINISHED.has(await job.getState())) return;
    await job.remove();
  }
  await addTimelineExecutionJob(queue, executionId);
}

/**
 * Sweep one batch of executions that have not ended.
 * @param queue - The `timeline` queue.
 * @returns Nothing; a row that fails is logged and left for the next sweep.
 * @throws {Error} When the batch cannot be read.
 */
export async function sweepTimelineExecutions(queue: Pick<Queue, "add" | "getJob">): Promise<void> {
  const rows = await timelineExecutionRepo.listForSweep({ limit: getTimelineConfig().web_animation.sweep_batch_size });
  for (const row of rows) {
    try {
      if (row.status === "awaiting_landing") {
        if (Date.parse(row.deadlineAt) <= Date.now()) await move(row, { type: "deadline" });
      } else if (row.status !== "queued" || (row.nextDispatchAt !== null && Date.parse(row.nextDispatchAt) <= Date.now())) {
        await ensureJob(queue, row.id);
      }
    } catch (err) {
      logger.error({ err, executionId: row.id, status: row.status }, "timeline_sweep_row_failed");
    }
  }
}
