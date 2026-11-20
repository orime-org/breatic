// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sweep of tasks still waiting for a running slot that the gate has not
 * judged for longer than `slot_wait_stale_ms` (inner#1968, design 3.9).
 *
 * Such a waiter no longer holds anyone back, but its credit hold stays held. Its job decides: one that no longer exists or has ended will not
 * pick the task up again, so the task ends here as failed through the same
 * path a job judged dead takes; one that still waits or runs is left to it and
 * logged. The gate records the judging job on a waiter that has none.
 */

import type { Queue } from "bullmq";
import { getWorkerConfig, logger } from "@breatic/core";
import { runningSlotService } from "@breatic/domain";
import type { TaskFailureReason } from "@breatic/shared";

/** Job states that will not pick the task up again. */
const ENDED = new Set(["completed", "failed", "unknown"]);

/**
 * One round of the sweep.
 * @param queue - The `tasks` queue, read for each waiter's job.
 * @returns Once every listed waiter has been looked at; one that fails is logged and left for the next round.
 * @throws {Error} When the waiters cannot be listed.
 */
export async function sweepSlotWaiters(queue: Pick<Queue, "getJob">): Promise<void> {
  for (const waiter of await runningSlotService.staleWaiters(getWorkerConfig().slot_wait_sweep_batch_size)) {
    try {
      const job = await queue.getJob(waiter.arqJobId);
      const state = job === undefined ? "missing" : await job.getState();
      if (job !== undefined && !ENDED.has(state)) {
        logger.warn({ taskId: waiter.id, userId: waiter.userId, jobId: waiter.arqJobId, state }, "slot_waiter_stale_job_alive");
        continue;
      }
      const ended = await runningSlotService.failTask(waiter.id, "internal" satisfies TaskFailureReason);
      logger.info({ taskId: waiter.id, userId: waiter.userId, jobId: waiter.arqJobId, state, failed: ended.failed }, "slot_waiter_job_lost");
      for (const err of ended.publishFailures) logger.error({ err, taskId: waiter.id }, "running_slot_publish_failed");
    } catch (err) {
      logger.error({ err, taskId: waiter.id, userId: waiter.userId }, "slot_wait_sweep_row_failed");
    }
  }
}
