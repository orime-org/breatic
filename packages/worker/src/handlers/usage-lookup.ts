// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Settle an OpenRouter call whose cost was not in hand (#296): one cut off
 * before it reported its cost, or one that ended without it.
 *
 * The job is queued with a delay and retried with backoff: OpenRouter keeps
 * generating for providers that cannot be cancelled, and answers the cost
 * only once the generation is over. The last attempt records what it has,
 * a missing figure included, so every call handed here leaves a row.
 */

import type { Job } from "bullmq";
import { getRawEnvVar, logger } from "@breatic/core";
import {
  createUsageRecorder,
  creditLotService,
  lookupGeneration,
  type GenerationAnswer,
  type UsageLookupJob,
} from "@breatic/domain";

/**
 * Look the generation up, record it, and charge it.
 * @param job - The queued lookup.
 * @param openRecorder - Opens the recorder; tests write rows elsewhere.
 * @returns Nothing once the call is recorded.
 * @throws {Error} While OpenRouter has no answer and attempts remain, so the
 *   queue asks again later.
 */
export async function runUsageLookup(
  job: Job<UsageLookupJob>,
  openRecorder: typeof createUsageRecorder = createUsageRecorder,
): Promise<void> {
  const data = job.data;
  const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

  let answer: GenerationAnswer | undefined;
  try {
    answer = await lookupGeneration(data.generationId, getRawEnvVar("OPENROUTER_API_KEY") ?? "");
  } catch (err) {
    if (!lastAttempt) throw err;
    logger.error({ err, generationId: data.generationId }, "agent_usage_lookup_failed");
  }
  const costUsd = answer?.costUsd;
  if (costUsd === undefined && !lastAttempt) {
    throw new Error(`OpenRouter has no cost for ${data.generationId} yet`);
  }

  const usage = openRecorder({
    operationKey: data.operationKey,
    feature: data.feature,
    actorUserId: data.actorUserId,
    projectId: data.projectId,
    onMissingCost: (row) =>
      logger.error({ row, generationId: data.generationId }, "agent_usage_cost_missing"),
  });
  usage.recordLookedUpCall({ source: data.source, model: data.model, costUsd, tokens: answer?.tokens });
  const { credits: amount, writeFailures } = await usage.settleForCharge();
  for (const err of writeFailures) {
    logger.error({ err, generationId: data.generationId }, "agent_usage_record_failed");
  }
  if (amount === 0 || !data.charge) return;

  // The charge request is recorded before the settlement, so a settlement
  // that fails waits pending for the sweep (inner#1617).
  try {
    const outcome = await creditLotService.chargeOnce("operation", `${data.operationKey}:gen:${data.generationId}`, {
      projectId: data.projectId,
      actorUserId: data.actorUserId,
      amount,
      description: data.description,
      model: data.model,
      provider: "openrouter",
    });
    if (outcome?.signalFailure) {
      logger.error(
        { err: outcome.signalFailure, generationId: data.generationId, projectId: data.projectId },
        "credits_signal_failed",
      );
    }
  } catch (err) {
    logger.error({ err, generationId: data.generationId, amount }, "credit_charge_settle_failed");
  }
}
