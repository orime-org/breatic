// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { DelayedError, type Job } from "bullmq";
import { logger } from "@breatic/core";
import { runningSlotService } from "@breatic/domain";
import { StillRunning } from "@worker/handlers/still-running.js";

/** What the running-task gate came to for a task that does not wait. */
export type RunningGateOutcome = Awaited<ReturnType<typeof runningSlotService.startWithinLimit>>;

/**
 * Pass a task nobody has run yet through the running-task gate (inner#1968 design 3.9): it starts when its person runs
 * fewer tasks than the limit, or goes back on the delayed queue without spending an attempt. Every task lane calls this
 * before its first run, so its budget counts from the start the gate gives.
 * @param job - The pickup.
 * @param token - This attempt's lock token; without one a wait is thrown to the caller.
 * @param taskId - The task.
 * @returns `started` with its start, or `ended` when it already reached its end.
 * @throws {DelayedError} When it waits and was moved back to the delayed queue.
 * @throws {StillRunning} When it waits and the pickup holds no token.
 * @throws {Error} When the gate's read or write fails.
 */
export async function passRunningGate(job: Job, token: string | undefined, taskId: string): Promise<RunningGateOutcome> {
  let gate: RunningGateOutcome;
  try {
    gate = await runningSlotService.startWithinLimit({ id: taskId, jobId: job.id ?? "" });
  } catch (err) {
    if (err instanceof StillRunning && token !== undefined) {
      logPublishFailures(taskId, err.publishFailures);
      await job.moveToDelayed(err.resumeAt, token);
      throw new DelayedError();
    }
    throw err;
  }
  logPublishFailures(taskId, gate.publishFailures);
  return gate;
}

/**
 * Log the canvas signals the running-task gate could not send: the rows are written, and a node's counts catch up on
 * its next change.
 * @param taskId - The task.
 * @param failures - What failed.
 */
function logPublishFailures(taskId: string, failures: readonly unknown[]): void {
  for (const err of failures) logger.error({ err, taskId }, "running_slot_publish_failed");
}
