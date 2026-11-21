// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `timeline` BullMQ queue's contract (inner#1711 design §5.1, §5.2; #1490 design §4.2): the server adds an
 * execution's job once its accept commits, the worker's sweep adds it again when it is missing, and the worker runs
 * it. One job per execution, under the execution's id, so adding it again while it waits is a no-op.
 */

import { defaultJobOpts, type createQueue } from "@breatic/core";

/** The queue Timeline executions run on. */
export const TIMELINE_QUEUE = "timeline";

/** The name of an execution's job. */
const TIMELINE_EXECUTION_JOB = "timeline-execution";

/** What an execution's job carries: only its id; the row holds everything else. */
export interface TimelineExecutionJobData {
  executionId: string;
}

/**
 * Add an execution's job under its own id; a job already holding that id is left as it is.
 * @param queue - The `timeline` queue.
 * @param executionId - The execution.
 * @returns Nothing once the job is in the queue.
 * @throws {Error} When Redis refuses the add.
 */
export async function addTimelineExecutionJob(queue: Pick<ReturnType<typeof createQueue>, "add">, executionId: string): Promise<void> {
  const data: TimelineExecutionJobData = { executionId };
  await queue.add(TIMELINE_EXECUTION_JOB, data, { ...defaultJobOpts(), jobId: executionId });
}
