// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `timeline` queue's `QueueEvents` 'failed' handler (inner#1711 design §5.2).
 *
 * A job that used up its retries is only logged: the row keeps its state, fence and hold, its container keeps
 * running, the sweep adds the job again and the original deadline finishes the execution.
 */

import type { Queue } from "bullmq";
import { logger, timelineExecutionRepo, type TimelineExecutionJobData } from "@breatic/core";

/**
 * Log a `timeline` job that failed for good; a failure with a retry still to come is not one.
 * @param queue - The `timeline` queue, to read the job back.
 * @param jobId - The failed job.
 * @param failedReason - What BullMQ recorded.
 * @returns Nothing.
 * @throws {Error} When Redis or the database cannot be read.
 */
export async function reportTimelineJobFailed(queue: Pick<Queue, "getJob">, jobId: string, failedReason: string): Promise<void> {
  const job = await queue.getJob(jobId);
  if (job === undefined || job.finishedOn === undefined) return;
  const executionId = (job.data as Partial<TimelineExecutionJobData>).executionId ?? jobId;
  const row = await timelineExecutionRepo.findById(executionId);
  logger.error(
    { executionId, attempt: row?.attempt ?? null, status: row?.status ?? null, failedReason, attemptsMade: job.attemptsMade },
    "timeline_job_retries_exhausted",
  );
}
