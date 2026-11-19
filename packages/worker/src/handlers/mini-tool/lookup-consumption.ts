// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { env, getRawEnvVar } from "@breatic/core";
import { containerCostUsd, getFullModelConfig, miniToolConsumptionRecordSchema, type MiniToolConsumptionRecord } from "@breatic/domain";
import { httpRequest, miniToolPlanJobRequestSchema, readMiniToolPlanJob, type MiniToolPlanJobRequest, type UntilDeadline } from "@breatic/shared";
import { bearerHeaders, HttpStatusError } from "@worker/providers/http.js";
import { planReportingEnd } from "@worker/handlers/mini-tool/advance-plan-job.js";

/** Original consumption and the immutable request needed to authenticate a container report. */
export interface MiniToolConsumptionLookupInput {
  consumption: MiniToolConsumptionRecord;
  plan?: MiniToolPlanJobRequest;
}

/** An unresolved expense is distinct from a positively confirmed zero. */
export type MiniToolConsumptionLookup =
  | { state: "pending"; reason: string }
  | { state: "known"; costUsd: number; costSource: "generation_lookup" | "computed"; raw: MiniToolConsumptionRecord["raw"] };

interface BillingLine { billingType: "deduct" | "refund"; price: number }

/**
 * Read fields only from an actual JSON object rather than assuming a vendor answer.
 * @param value - A parsed JSON value.
 * @returns Its object fields or null for a scalar, array or null.
 * @throws {never} This operation never throws.
 */
function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Sum original decimal prices without turning a full refund into a floating-point residual.
 * @param lines - Validated deductions and refunds from one complete billing answer.
 * @returns Their signed total at the numeric boundary used by consumption persistence.
 * @throws {never} Validated finite decimal numbers always have an integer representation.
 */
function billingTotal(lines: BillingLine[]): number {
  const values = lines.map((line) => {
    const [mantissa, power] = String(line.price).split("e");
    const [whole, fraction = ""] = mantissa!.split(".");
    return { coefficient: BigInt(whole! + fraction) * (line.billingType === "deduct" ? 1n : -1n), exponent: Number(power ?? 0) - fraction.length };
  });
  const exponent = values.reduce((lowest, value) => Math.min(lowest, value.exponent), values[0]!.exponent);
  const total = values.reduce((sum, value) => sum + value.coefficient * 10n ** BigInt(value.exponent - exponent), 0n);
  return Number(`${total}e${exponent}`);
}

/**
 * Read a prediction's complete bill through its original provider connection.
 * @param predictionId - The immutable accepted WaveSpeed identity.
 * @param bound - The caller's current read lifetime.
 * @returns Actual cost, including explicit zero, or an unresolved answer.
 * @throws {Error} When credentials, transport or HTTP status prevent the read.
 */
async function lookupProvider(predictionId: string, bound: UntilDeadline): Promise<MiniToolConsumptionLookup> {
  const connection = getFullModelConfig("video").providers.wavespeed;
  const apiKey = getRawEnvVar(connection?.api_key_env ?? "");
  if (!connection?.base_url || !apiKey) throw new Error("Original WaveSpeed billing connection is unavailable");
  const response = await httpRequest(`${connection.base_url}/billings/search`, {
    method: "POST", headers: bearerHeaders(apiKey), body: JSON.stringify({ prediction_uuids: [predictionId] }),
  }, { replaySafe: true, ...bound });
  if (!response.ok) throw new HttpStatusError("wavespeed", response.status, await response.text());
  const raw = miniToolConsumptionRecordSchema.shape.raw.parse(await response.json());
  const body = objectValue(raw);
  const data = objectValue(body?.data);
  if (body?.code !== 200 || data?.has_more !== false || !Array.isArray(data.items)) return { state: "pending", reason: "billing-incomplete" };
  const lines: BillingLine[] = [];
  for (const value of data.items) {
    const line = objectValue(value);
    const price = objectValue(line?.order)?.price;
    const billingType = line?.billing_type;
    if ((billingType !== "deduct" && billingType !== "refund") || typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      return { state: "pending", reason: "billing-incomplete" };
    }
    lines.push({ billingType, price });
  }
  if (!lines.some((line) => line.billingType === "deduct")) return { state: "pending", reason: "billing-incomplete" };
  const costUsd = billingTotal(lines);
  if (!Number.isFinite(costUsd) || costUsd < 0) return { state: "pending", reason: "billing-amount-invalid" };
  return { state: "known", costUsd, costSource: "generation_lookup", raw };
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
    return { state: "known", costUsd: consumption.costUsd!, costSource: consumption.costSource!, raw: consumption.raw };
  }
  const identity = consumption.identity;
  if (identity.kind === "provider") return lookupProvider(identity.predictionId, bound);
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
