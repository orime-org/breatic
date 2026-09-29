// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cost of an OpenRouter call whose cost was not in hand (#296).
 *
 * A streamed call reports its cost on its last chunk, which a stopped stream
 * never receives, and a call can also end without one. OpenRouter keeps
 * generating for providers that cannot be cancelled and bills the whole
 * response, so the cost is only settled once the generation is over; its
 * `/generation` endpoint answers it by id.
 */

import { createQueue, getAgentConfig } from "@breatic/core";
import { httpRequest } from "@breatic/shared";

import type { TokenBuckets } from "@domain/credit/usage-cost.js";
import type {
  RecordedOperation,
  UsageFeature,
  UsageSource,
} from "@domain/credit/usage-recorder.js";

/** The queue the later lookup travels on. */
export const USAGE_LOOKUP_QUEUE = "usage-lookup";

/** One call to look up, as the worker receives it. */
export interface UsageLookupJob {
  generationId: string;
  model: string;
  operationKey: string;
  feature: UsageFeature;
  source: UsageSource;
  actorUserId: string;
  projectId: string | null;
  /** What the ledger row says the charge was for. */
  description: string;
}

/** What OpenRouter answers about a generation. */
export interface GenerationAnswer {
  /** In US dollars; undefined when the answer carries none. */
  costUsd: number | undefined;
  tokens: TokenBuckets;
}

/**
 * A token count off the answer.
 * @param value - The field as OpenRouter sent it.
 * @returns The count, or 0 when it is absent.
 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Ask OpenRouter what a generation cost and used.
 * @param generationId - The id its chunks carried.
 * @param apiKey - The OpenRouter key.
 * @returns The answer, or undefined while the generation is not there yet.
 * @throws {Error} When OpenRouter refuses the request for any other reason.
 */
export async function lookupGeneration(
  generationId: string,
  apiKey: string,
): Promise<GenerationAnswer | undefined> {
  const url = `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`;
  const res = await httpRequest(
    url,
    { headers: { Authorization: `Bearer ${apiKey}` }, redirect: "manual" },
    { replaySafe: true },
  );
  if (res.status === 404) {
    void res.body?.cancel();
    return undefined;
  }
  if (!res.ok) {
    void res.body?.cancel();
    throw new Error(`OpenRouter generation lookup answered ${res.status}`);
  }
  const body = (await res.json()) as { data?: Record<string, unknown> };
  const data = body.data ?? {};
  const cost = data.total_cost;
  return {
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined,
    tokens: {
      input: count(data.native_tokens_prompt),
      cachedInput: count(data.native_tokens_cached),
      output: count(data.native_tokens_completion),
      reasoning: count(data.native_tokens_reasoning),
    },
  };
}

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * Queue the later lookup of one call.
 *
 * Keyed by the generation id, so a second hand-off of the same call is one
 * job.
 * @param job - The call and the operation it belongs to.
 * @returns Nothing once the job is queued.
 */
async function enqueueUsageLookup(job: UsageLookupJob): Promise<void> {
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

/**
 * Queue the later lookup of each call an operation could not price.
 * @param generationIds - The calls, by generation id.
 * @param operation - The operation they belong to.
 * @param call - The model they called, and what a ledger row says the charge was for.
 * @param call.model - The model id.
 * @param call.description - What the ledger row says the charge was for.
 * @returns Nothing once every job is queued.
 */
export async function handOffLookups(
  generationIds: readonly string[],
  operation: RecordedOperation,
  call: { model: string; description: string },
): Promise<void> {
  for (const generationId of generationIds) {
    await enqueueUsageLookup({ ...operation, generationId, model: call.model, source: "model", description: call.description });
  }
}
