// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Settle a model call whose cost was not in hand (#296): one cut off before it reported its cost, or one that ended
 * without it.
 *
 * The job is queued with a delay and retried with backoff: an upstream that keeps generating for a backend that
 * cannot be cancelled answers the cost only once the generation is over. The last attempt records what provider
 * answers, a missing figure included, so every call handed here leaves a row.
 */

import type { Job } from "bullmq";
import { logger } from "@breatic/core";
import type { Cost, CostLookup } from "@breatic/provider";
import { createUsageRecorder, creditLotService, provider, type UsageLookupJob } from "@breatic/domain";

/**
 * The lookup a job carries, and the upstream that served its call: a job queued before lookups named their upstream
 * carries a generation id alone, which provider turns into a lookup.
 * @param data - The job's data.
 * @returns The lookup, or undefined when provider can make none of the generation id.
 */
function lookupOf(data: UsageLookupJob): CostLookup | undefined {
  return "lookup" in data ? data.lookup : provider().cost.fromGeneration(data.generationId);
}

/**
 * Look the call up, record it, and charge it.
 * @param job - The queued lookup.
 * @param openRecorder - Opens the recorder; tests write rows elsewhere.
 * @returns Nothing once the call is recorded.
 * @throws {Error} While provider answers the cost pending and attempts remain, so the queue asks again later.
 */
export async function runUsageLookup(
  job: Job<UsageLookupJob>,
  openRecorder: typeof createUsageRecorder = createUsageRecorder,
): Promise<void> {
  const data = job.data;
  const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  const lookup = lookupOf(data);
  const cost: Cost = lookup === undefined
    ? { state: "missing", reason: "the job names no lookup provider can make" }
    : await provider().cost.lookup(lookup, { lastAttempt });
  if (cost.state === "pending") throw new Error(`The cost of ${JSON.stringify(lookup)} is not answered yet`);
  const upstream = "upstream" in data ? data.upstream : (lookup?.upstream ?? "");

  const usage = openRecorder({
    operationKey: data.operationKey,
    feature: data.feature,
    actorUserId: data.actorUserId,
    projectId: data.projectId,
    onMissingCost: (row) => logger.error({ row, lookup }, "agent_usage_cost_missing"),
  });
  usage.recordLookedUpCall({ source: data.source, model: data.model, upstream, cost });
  const { credits: amount, writeFailures } = await usage.settleForCharge();
  for (const err of writeFailures) {
    logger.error({ err, lookup }, "agent_usage_record_failed");
  }
  if (amount === 0 || !data.charge) return;

  // The charge request is recorded before the settlement, so a settlement that fails waits pending for the sweep
  // (inner#1617). A call looked up by its generation keeps the key it was charged under before lookups named their
  // upstream, so a job queued across a deploy is charged once.
  const generationId = typeof lookup?.generationId === "string" ? lookup.generationId : undefined;
  const refKey = generationId === undefined ? `${data.operationKey}:lookup:${JSON.stringify(lookup)}` : `${data.operationKey}:gen:${generationId}`;
  try {
    const outcome = await creditLotService.chargeOnce("operation", refKey, {
      projectId: data.projectId,
      actorUserId: data.actorUserId,
      amount,
      description: data.description,
      model: data.model,
      provider: upstream,
    });
    if (outcome?.signalFailure) {
      logger.error(
        { err: outcome.signalFailure, lookup, projectId: data.projectId },
        "credits_signal_failed",
      );
    }
  } catch (err) {
    logger.error({ err, lookup, refKey, actorUserId: data.actorUserId, amount }, "credit_charge_settle_failed");
  }
}
