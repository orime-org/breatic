// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Timeline sweep (inner#1711 design §5.2), run on a schedule over every execution that has not ended; the server
 * adds a job when it accepts a row, and the sweep adds one that is missing.
 *
 * An awaiting-landing row past its original deadline expires; a deleted Space gets no handling of its own, as with
 * canvas tasks. Every queued, running or cancelling row must have a live job under its execution id: a missing,
 * failed or completed job is removed and added again, because the queue's retention would otherwise keep the old job
 * id occupied. Nothing here calls the ingest Worker.
 */

import type { Queue } from "bullmq";
import { getTimelineConfig, logger } from "@breatic/core";
import { addTimelineExecutionJob, timelineExecutionRepo } from "@breatic/domain";
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
 * Sweep every execution that has not ended, a batch at a time.
 * @param queue - The `timeline` queue.
 * @returns Nothing; a row that fails is logged and left for the next sweep.
 * @throws {Error} When a batch cannot be read.
 */
export async function sweepTimelineExecutions(queue: Pick<Queue, "add" | "getJob">): Promise<void> {
  const limit = getTimelineConfig().web_animation.sweep_batch_size;
  let afterId: string | undefined;
  for (;;) {
    const rows = await timelineExecutionRepo.listForSweep({ limit, ...(afterId !== undefined && { afterId }) });
    for (const row of rows) {
      try {
        if (row.status === "awaiting_landing") {
          if (Date.parse(row.deadlineAt) <= Date.now()) await move(row, { type: "deadline" });
        } else {
          await ensureJob(queue, row.id);
        }
      } catch (err) {
        logger.error({ err, executionId: row.id, status: row.status }, "timeline_sweep_row_failed");
      }
    }
    if (rows.length < limit) return;
    afterId = rows.at(-1)!.id;
  }
}
