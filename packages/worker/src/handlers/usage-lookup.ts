// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  const amount = await usage.settle();
  if (amount === 0 || !data.charge) return;

  // The row is written; a retry would write a second one. A charge that
  // fails is logged for reconciliation, the way a turn's own charge is.
  try {
    await creditLotService.chargeOnceForGeneration(`${data.operationKey}:gen:${data.generationId}`, {
      projectId: data.projectId,
      actorUserId: data.actorUserId,
      amount,
      description: data.description,
      model: data.model,
      provider: "openrouter",
    });
  } catch (err) {
    logger.error({ err, generationId: data.generationId, amount }, "agent_usage_lookup_charge_failed");
  }
}
