// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Records every paid call one operation makes (#296).
 *
 * An operation is a chat turn, a consolidation, a text-tool run or a task.
 * Each paid call inside it writes one row where it happens; `settle` waits
 * for those writes and hands back the credits this recorder saw, which the
 * caller passes to the credit engine. It adds up its own rows only: two
 * recorders can share an operation key (a retried task, a consolidation two
 * tabs raced), and what one of them spent is not the other's to charge.
 */

import { env, getUsagePricing, type UsagePricing } from "@breatic/core";
import { insertUsageRecord } from "@domain/credit/agentUsage.repo.js";
import {
  costOfModelCall,
  creditsForUsd,
  type CostSource,
  type ModelCall,
} from "@domain/credit/usage-cost.js";

/** Which operation a row belongs to. */
export type UsageFeature =
  | "chat_turn"
  | "memory_consolidation"
  | "text_tool"
  | "canvas_understand"
  | "skill_task";

/** What inside the operation made the call. */
export type UsageSource =
  | "model"
  | "tool:understand_media"
  | "tool:web_search"
  | "tool:search_images"
  | "tool:judge_likelihood";

/** A service priced per request in `config/usage-pricing.yaml`. */
export type PricedService = keyof UsagePricing["services"];

/** One row of `agent_usage_records`, before it is written. */
export interface UsageRow {
  operationKey: string;
  feature: UsageFeature;
  source: UsageSource;
  actorUserId: string;
  projectId: string | null;
  model: string;
  provider: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  requestCount: number | null;
  costUsd: number;
  costSource: CostSource;
  credits: number;
}

/** A paid call to a service that is not a language model. */
export interface ServiceCall {
  source: UsageSource;
  /** A priced service, or the model id the service reported a cost for. */
  service: string;
  provider: string;
  requests: number;
  /** The cost the service reported; absent means price it from the table. */
  costUsd?: number;
}

/** An interrupted OpenRouter call, once its generation was looked up. */
export interface LookedUpCall {
  source: UsageSource;
  model: string;
  /** What OpenRouter answered; undefined when it never found the generation. */
  costUsd: number | undefined;
}

/** The operation a recorder writes its rows under. */
export interface RecordedOperation {
  operationKey: string;
  feature: UsageFeature;
  actorUserId: string;
  projectId: string | null;
}

/** A recorder for one operation. */
export interface UsageRecorder {
  /** What its rows are recorded under; charges for them use the same key. */
  readonly operation: RecordedOperation;
  recordModelCall(call: ModelCall & { source: UsageSource }): void;
  recordServiceCall(call: ServiceCall): void;
  recordLookedUpCall(call: LookedUpCall): void;
  settle(): Promise<number>;
}

/** What a recorder is opened with. */
export interface UsageRecorderOptions {
  operationKey: string;
  feature: UsageFeature;
  actorUserId: string;
  projectId: string | null;
  /** Defaults to `config/usage-pricing.yaml`. */
  pricing?: UsagePricing;
  /** Defaults to `CREDIT_MULTIPLIER`. */
  multiplier?: number;
  /** Defaults to appending to `agent_usage_records`. */
  write?: (row: UsageRow) => Promise<void>;
  /**
   * Called for a row whose cost the service should have reported and did not.
   * The row is still written, at zero; this is how the caller, which can log,
   * hears that it undercharged.
   */
  onMissingCost: (row: UsageRow) => void;
}

/**
 * Work out a service call's dollars and where they came from.
 * @param call - The call.
 * @param pricing - The per-request prices.
 * @returns Dollars and their source.
 * @throws {Error} When the call reported no cost and its service has no price.
 */
function serviceCost(
  call: ServiceCall,
  pricing: UsagePricing,
): { costUsd: number; costSource: CostSource } {
  if (call.costUsd !== undefined) return { costUsd: call.costUsd, costSource: "provider" };
  // OpenRouter reports what it charged on every answer and has no table of
  // ours to fall back on, the same rule `costOfModelCall` applies.
  if (call.provider === "openrouter") return { costUsd: 0, costSource: "missing" };
  const price = pricing.services[call.service as PricedService];
  if (!price) {
    throw new Error(`No price for service ${call.service} in config/usage-pricing.yaml`);
  }
  return { costUsd: price.per_request * call.requests, costSource: "price_table" };
}

/**
 * Open a recorder for one operation.
 * @param options - The operation and, for tests, where prices and rows come from.
 * @returns A recorder.
 */
export function createUsageRecorder(options: UsageRecorderOptions): UsageRecorder {
  const pricing = options.pricing ?? getUsagePricing();
  const multiplier = options.multiplier ?? env.CREDIT_MULTIPLIER;
  const write = options.write ?? insertUsageRecord;
  const pending: Promise<void>[] = [];
  // A write that fails before `settle` is awaited is held here, so it never
  // surfaces as an unhandled rejection; `settle` throws the first one.
  const failures: unknown[] = [];
  let credits = 0;

  const base = {
    operationKey: options.operationKey,
    feature: options.feature,
    actorUserId: options.actorUserId,
    projectId: options.projectId,
  };

  /**
   * Count a row's credits and start writing it.
   * The write joins what `settle` waits for.
   * @param row - The row.
   */
  const append = (row: UsageRow): void => {
    credits += row.credits;
    pending.push(write(row).catch((err: unknown) => void failures.push(err)));
    if (row.costSource === "missing") options.onMissingCost(row);
  };

  return {
    operation: base,
    recordModelCall(call) {
      const cost = costOfModelCall(call, pricing);
      append({
        ...base,
        source: call.source,
        model: call.model,
        provider: call.provider,
        inputTokens: cost.tokens.input,
        cachedInputTokens: cost.tokens.cachedInput,
        outputTokens: cost.tokens.output,
        reasoningTokens: cost.tokens.reasoning,
        requestCount: null,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        credits: creditsForUsd(cost.costUsd, multiplier),
      });
    },
    recordServiceCall(call) {
      const cost = serviceCost(call, pricing);
      append({
        ...base,
        source: call.source,
        model: call.service,
        provider: call.provider,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        requestCount: call.requests,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        credits: creditsForUsd(cost.costUsd, multiplier),
      });
    },
    recordLookedUpCall(call) {
      const costUsd = call.costUsd ?? 0;
      append({
        ...base,
        source: call.source,
        model: call.model,
        provider: "openrouter",
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        requestCount: 1,
        costUsd,
        costSource: call.costUsd === undefined ? "missing" : "generation_lookup",
        credits: creditsForUsd(costUsd, multiplier),
      });
    },
    async settle() {
      await Promise.all(pending);
      if (failures.length > 0) throw failures[0];
      return credits;
    },
  };
}
