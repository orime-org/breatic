// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Hands an interrupted OpenRouter call to the worker, which looks its cost up
 * once the generation is over (#296).
 */

import type { Queue } from "bullmq";
import { createQueue, getAgentConfig } from "@breatic/core";
import { USAGE_LOOKUP_QUEUE, type UsageLookupJob } from "@breatic/domain";

let queue: Queue | undefined;

/**
 * Queue the later lookup of one interrupted call.
 *
 * Keyed by the generation id, so a second hand-off of the same call is one
 * job.
 * @param job - The call and the operation it belongs to.
 * @returns Nothing once the job is queued.
 */
export async function enqueueUsageLookup(job: UsageLookupJob): Promise<void> {
  queue ??= createQueue(USAGE_LOOKUP_QUEUE);
  const { usage_lookup_delay_ms: delay, usage_lookup_attempts: attempts } = getAgentConfig();
  await queue.add("lookup", job, {
    jobId: job.generationId,
    delay,
    attempts,
    backoff: { type: "exponential", delay },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86_400, count: 1000 },
  });
}
