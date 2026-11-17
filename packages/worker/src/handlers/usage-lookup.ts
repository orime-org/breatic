// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settle a model call whose cost was not in hand (#296): one cut off before it reported its cost, or one that ended
 * without it.
 *
 * The job is queued with a delay and retried with backoff: an upstream that keeps generating for a backend that
 * cannot be cancelled answers the cost only once the generation is over. The last attempt records what provider
 * answers, a missing figure included, so every call handed here leaves a row.
 *
 * A call an account's own key paid (inner#1953) is queued with that key row's id, never the key: the key is read by
 * the id and the upstream asked with it, the call recorded at 0 credits under the row and never charged. Once the row
 * was replaced or deleted it cannot be asked any more: the call is recorded as missing and the job ends.
 */

import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { logger } from "@breatic/core";
import { accountKeyFailureIn, type Cost, type CostLookup, type KeySet } from "@breatic/provider";
import { createUsageRecorder, creditLotService, keysById, provider, type UsageLookupJob } from "@breatic/domain";

/** What a lookup records once the account key row that paid the call is gone. */
const KEY_GONE: Cost = { state: "missing", reason: "the account key that paid it was replaced or deleted", payer: "account" };

/**
 * The account's keys a job's call was paid with, read by the key row's id.
 * @param keyId - The row the job names; absent for a call our keys paid.
 * @returns The keys, null once the row was replaced or deleted, or undefined for ours.
 * @throws {ProviderKeySealBroken} When the sealed key cannot be opened; the queue asks again.
 */
async function accountKeys(keyId: string | undefined): Promise<KeySet | null | undefined> {
  if (keyId === undefined) return undefined;
  try {
    return (await keysById(keyId))?.keys ?? null;
  } catch (err) {
    if (accountKeyFailureIn(err)?.kind === "account_key_missing") return null;
    throw err;
  }
}

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
 * @throws {ProviderKeySealBroken} When the account's sealed key cannot be opened; the queue asks again.
 */
export async function runUsageLookup(
  job: Job<UsageLookupJob>,
  openRecorder: typeof createUsageRecorder = createUsageRecorder,
): Promise<void> {
  const data = job.data;
  const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  const lookup = lookupOf(data);
  const keyId = data.keyId;
  const keys = await accountKeys(keyId);
  let cost: Cost;
  if (keys === null) cost = KEY_GONE;
  else if (lookup === undefined) cost = { state: "missing", reason: "the job names no lookup provider can make" };
  else cost = await provider().cost.lookup(lookup, { lastAttempt, ...(keys !== undefined && { keys }) });
  if (cost.state === "pending") throw new Error(`The cost of ${JSON.stringify(lookup)} is not answered yet`);
  const upstream = "upstream" in data ? data.upstream : (lookup?.upstream ?? "");

  const usage = openRecorder({
    operationKey: data.operationKey,
    feature: data.feature,
    actorUserId: data.actorUserId,
    projectId: data.projectId,
    onMissingCost: (row) => logger.error({ row, lookup }, "agent_usage_cost_missing"),
    ...(keyId !== undefined && { keyId }),
  });
  usage.recordLookedUpCall({ source: data.source, model: data.model, upstream, cost });
  const { credits: amount, writeFailures } = await usage.settleForCharge();
  for (const err of writeFailures) {
    logger.error({ err, lookup }, "agent_usage_record_failed");
  }
  if (amount === 0 || !data.charge) return;

  // The charge request is recorded before the settlement, so a settlement that fails waits pending for the sweep
  // (inner#1617). A job queued before lookups named their upstream keeps the key it was charged under then, so one
  // queued across a deploy is charged once; any other is charged under its lookup's hash, its queued job's id.
  const refKey = "lookup" in data
    ? `${data.operationKey}:lookup:${createHash("sha256").update(JSON.stringify(data.lookup)).digest("hex")}`
    : `${data.operationKey}:gen:${data.generationId}`;
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
