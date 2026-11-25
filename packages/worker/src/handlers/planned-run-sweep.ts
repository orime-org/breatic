// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sweep of planned video tool runs whose job will not pick them up again (frames-split design §7.19), the
 * counterpart of the slot-wait sweep: a running run, or a pending run that never waited for a running slot and is older than
 * the grace window, whose job has ended or is gone is ended by the planned-run recovery. A run whose job still waits or
 * runs is left to that job. One run that fails is logged and left for the next round.
 */

import type { Queue } from "bullmq";
import { getWorkerConfig, logger } from "@breatic/core";
import { miniToolExecutionService } from "@breatic/domain";
import { recoverPlannedRun } from "@worker/handlers/mini-tool/recover-planned-run.js";

/** Job states that will not pick the task up again. */
const ENDED = new Set(["completed", "failed", "unknown"]);

/**
 * Whether a run's job will pick it up again: its job id is its task id (planned-run.ts).
 * @param queue - The `tasks` queue.
 * @param taskId - The run.
 * @returns True while its job waits or runs.
 * @throws {Error} When the queue read fails.
 */
async function jobAlive(queue: Pick<Queue, "getJob">, taskId: string): Promise<boolean> {
  const job = await queue.getJob(taskId);
  return job !== undefined && !ENDED.has(await job.getState());
}

/**
 * One round of the sweep.
 * @param queue - The `tasks` queue, read for each run's job.
 * @returns Once every listed run has been looked at.
 * @throws {Error} When the runs cannot be listed.
 */
export async function sweepPlannedRuns(queue: Pick<Queue, "getJob">): Promise<void> {
  const config = getWorkerConfig();
  const { running, pending } = await miniToolExecutionService.plannedRunsToSweep(config.planned_run_sweep_batch_size, config.planned_run_sweep_grace_ms);
  for (const taskId of [...running, ...pending]) {
    try {
      if (await jobAlive(queue, taskId)) continue;
      if (await recoverPlannedRun(taskId)) logger.info({ taskId }, "planned_run_lost_job_recovered");
    } catch (err) {
      logger.error({ err, taskId }, "planned_run_sweep_row_failed");
    }
  }
}
