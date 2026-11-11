// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The later lookup of a model call whose cost was not in hand (#296).
 *
 * A streamed call reports its cost on its last chunk, which a stopped stream never receives, and an upstream can bill
 * a call before it knows the amount. provider answers such a call `pending` with a lookup; this queues the lookup,
 * and the worker's `usage-lookup` handler asks provider again later, records the call and charges it.
 */

import { createHash } from "node:crypto";
import { createQueue, getAgentConfig } from "@breatic/core";
import type { CostLookup } from "@breatic/provider";

import type {
  RecordedOperation,
  UsageFeature,
  UsageSource,
} from "@domain/credit/usage-recorder.js";

/** The queue the later lookup travels on. */
export const USAGE_LOOKUP_QUEUE = "usage-lookup";

/** What every queued lookup carries about the call and its operation. */
interface UsageLookupCall {
  model: string;
  operationKey: string;
  feature: UsageFeature;
  source: UsageSource;
  actorUserId: string;
  projectId: string | null;
  /** What the ledger row says the charge was for. */
  description: string;
  /** Whether the operation is charged; a failed worker task is recorded only. */
  charge: boolean;
}

/**
 * One call to look up, as the worker receives it: provider's lookup and the upstream that served the call, or, for a
 * job queued before lookups named their upstream, the generation id alone.
 */
export type UsageLookupJob = UsageLookupCall & ({ lookup: CostLookup; upstream: string } | { generationId: string });

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * Queue the later lookup of one call, keyed by its lookup's hash, so a second hand-off of the same call is one job.
 * @param job - The call and the operation it belongs to.
 * @returns Nothing once the job is queued.
 */
async function enqueueUsageLookup(job: UsageLookupCall & { lookup: CostLookup; upstream: string }): Promise<void> {
  queue ??= createQueue(USAGE_LOOKUP_QUEUE);
  const { usage_lookup_delay_ms: delay, usage_lookup_attempts: attempts } = getAgentConfig();
  await queue.add("lookup", job, {
    jobId: createHash("sha256").update(JSON.stringify(job.lookup)).digest("hex"),
    delay,
    attempts,
    backoff: { type: "exponential", delay },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86_400, count: 1000 },
  });
}

/**
 * Queue the later lookup of each call an operation could not price.
 * @param lookups - provider's lookups of the pending costs.
 * @param operation - The operation they belong to.
 * @param call - The model they called, what a ledger row says the charge was for, and whether it is charged; each
 *   lookup names the upstream that served its call.
 * @param call.model - The model id.
 * @param call.description - What the ledger row says the charge was for.
 * @param call.charge - Whether the operation is charged.
 * @returns Nothing once every job is queued.
 */
export async function handOffLookups(
  lookups: readonly CostLookup[],
  operation: RecordedOperation,
  call: { model: string; description: string; charge: boolean },
): Promise<void> {
  for (const lookup of lookups) {
    await enqueueUsageLookup({ ...operation, ...call, lookup, upstream: lookup.upstream, source: "model" });
  }
}
