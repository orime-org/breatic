// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { env, logger } from "@breatic/core";
import { containerCostUsd, miniToolConsumptionRecordSchema, provider, type MiniToolConsumptionRecord } from "@breatic/domain";
import type { Cost } from "@breatic/provider";
import { miniToolPlanJobRequestSchema, readMiniToolPlanJob, type MiniToolPlanJobRequest, type UntilDeadline } from "@breatic/shared";
import { planReportingEnd } from "@worker/handlers/mini-tool/advance-plan-job.js";

/** Original consumption, the immutable request needed to authenticate a container report and whether this lookup is the last. */
export interface MiniToolConsumptionLookupInput {
  consumption: MiniToolConsumptionRecord;
  plan?: MiniToolPlanJobRequest;
  lastAttempt?: boolean;
}

/**
 * An unresolved container expense is distinct from a positively confirmed zero; a model step's lookup answers each of
 * its waiting costs.
 */
export type MiniToolConsumptionLookup =
  | { state: "pending"; reason: string }
  | { state: "known"; costUsd: number; costSource: "computed"; raw: MiniToolConsumptionRecord["raw"] }
  | { state: "looked_up"; costs: Cost[] };

/**
 * Ask provider again about each cost a model step waits on (inner#1306 execution design §11.4 lookup row), the last
 * lookup the wait allows answering known or missing, as a canvas generation's wait does.
 * @param consumption - The step's pending consumption.
 * @param lastAttempt - Whether no later lookup follows.
 * @returns Each waiting cost's answer, in order.
 * @throws {Error} When a lookup fails; the settlement defers and asks again.
 */
async function lookupModelStep(consumption: MiniToolConsumptionRecord, lastAttempt: boolean): Promise<MiniToolConsumptionLookup> {
  const costs: Cost[] = [];
  for (const waiting of consumption.waiting ?? []) {
    const cost = waiting.cost !== undefined && waiting.cost.state !== "pending" ? waiting.cost : await provider().cost.lookup(waiting.lookup, { lastAttempt });
    if (cost.state === "missing") logger.warn({ ctx: { consumptionKey: consumption.consumptionKey, reason: cost.reason } }, "cost_unavailable");
    costs.push(cost);
  }
  return { state: "looked_up", costs };
}

/**
 * Read one original upstream identity without submitting or changing computation.
 * @param input - The durable consumption and any original planned request.
 * @param bound - This read's lifetime, independent of the completed computation deadline.
 * @returns Confirmed actual expense or an explicitly unresolved result.
 * @throws {Error} When configuration, identity, transport or report validation fails.
 */
export async function lookupMiniToolConsumption(input: MiniToolConsumptionLookupInput, bound: UntilDeadline): Promise<MiniToolConsumptionLookup> {
  const consumption = miniToolConsumptionRecordSchema.parse(input.consumption);
  if (consumption.state !== "pending") {
    return { state: "known", costUsd: consumption.costUsd!, costSource: "computed", raw: consumption.raw };
  }
  const identity = consumption.identity;
  if (identity.kind === "provider") return lookupModelStep(consumption, input.lastAttempt === true);
  const plan = miniToolPlanJobRequestSchema.parse(input.plan);
  if (plan.jobId !== identity.jobId || plan.containerClass !== identity.containerClass) {
    throw new Error("Consumption identity differs from its original container request");
  }
  const report = await readMiniToolPlanJob(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, plan, bound);
  // Ingest turns a submit after the job's deadline into a failed record, so a job it does not hold once the reporting window
  // (advanceMiniToolPlanJob's) has closed was never submitted: an attempt that never ran costs the user nothing.
  if (report === null && Date.now() >= planReportingEnd(plan.deadlineAt)) return { state: "known", costUsd: 0, costSource: "computed", raw: null };
  if (report === null || report.state === "starting" || report.state === "running") return { state: "pending", reason: "container-report-pending" };
  // An ended attempt with no usage had a container that never started or vanished without measuring itself: the
  // failure is ours, so it costs the user nothing. Missing CPU time alone is priced from the provisioned vCPU.
  if (report.usage === null) return { state: "known", costUsd: 0, costSource: "computed", raw: report };
  const policy = consumption.containerPricing!;
  const costUsd = containerCostUsd(report.usage, policy.size, policy.prices);
  if (!Number.isFinite(costUsd) || costUsd < 0) return { state: "pending", reason: "container-amount-invalid" };
  return { state: "known", costUsd, costSource: "computed", raw: report };
}
