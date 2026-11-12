// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import type { Cost, CostLookup } from "@breatic/provider";
import { insertUsageRecord } from "@domain/credit/agentUsage.repo.js";
import { toChargeCredits } from "@domain/credit/credit-math.js";
import { creditsForUsd, type CostSource } from "@domain/credit/usage-cost.js";

/** Which operation a row belongs to. */
export type UsageFeature =
  | "chat_turn"
  | "memory_consolidation"
  | "text_tool"
  | "canvas_understand"
  | "canvas_transcribe"
  | "mini_tool"
  | "timeline_web_animation";

/** What inside the operation made the call. */
export type UsageSource =
  | "model"
  | "tool:understand_media"
  | "tool:web_search"
  | "tool:web_fetch"
  | "tool:search_images"
  | "tool:judge_likelihood"
  | "container";

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
  /** The call's stable identity, when it has one; a second row with the same identity is never written. */
  costIdentity: string | null;
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
  /** Where `costUsd` came from, when it is not the service's own report. */
  costSource?: CostSource;
}

/** A model call as a recorder receives it: what provider said it cost. */
export interface RecordedModelCall {
  source: UsageSource;
  /** Our model id. */
  model: string;
  /** The upstream that served the call. */
  upstream: string;
  cost: Cost;
  /** The requests the row counts, for a call recorded as one request (an understand or decisions call). */
  requests?: number;
  /**
   * A stable identity for the call (a Timeline execution's `timeline:<executionId>:<seq>`), so settling the same
   * call again writes nothing.
   */
  costIdentity?: string;
}

/** A call whose cost was pending, once provider looked it up: known, or missing on the last attempt. */
export interface LookedUpCall {
  source: UsageSource;
  model: string;
  upstream: string;
  cost: Cost;
}

/** A pending call's lookup, with what made the call and the model it called, which its row is written under. */
export interface AwaitedLookup {
  lookup: CostLookup;
  source: UsageSource;
  model: string;
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
  /**
   * Record a model call. A pending cost writes no row; its lookup waits in `awaitingLookup`.
   */
  recordModelCall(call: RecordedModelCall): void;
  recordServiceCall(call: ServiceCall): void;
  recordLookedUpCall(call: LookedUpCall): void;
  /** The lookups of the pending costs, each with its call's source and model, for the caller to queue. */
  awaitingLookup(): readonly AwaitedLookup[];
  /** Wait for every row, then answer what to charge: their credits rounded up to whole cents. Each row keeps its exact figure. */
  settle(): Promise<number>;
  /**
   * Wait for every row, then answer what to charge and which row writes failed.
   * The credits are counted before a row is written, so a failed write leaves
   * the figure whole: the caller charges it and logs the failures.
   */
  settleForCharge(): Promise<{ credits: number; writeFailures: readonly unknown[] }>;
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
  if (call.costUsd !== undefined) return { costUsd: call.costUsd, costSource: call.costSource ?? "provider" };
  const price = pricing.services[call.service as PricedService];
  if (!price) {
    throw new Error(`No price for service ${call.service} in config/usage-pricing.yaml`);
  }
  return { costUsd: price.per_request * call.requests, costSource: "price_table" };
}

/** Where a known cost came from, in the words of `agent_usage_records.cost_source`. */
const SOURCE_OF: Readonly<Record<Extract<Cost, { state: "known" }>["source"], CostSource>> = {
  reported: "provider",
  price_table: "price_table",
  billing: "generation_lookup",
};

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
  const lookups = new Map<string, AwaitedLookup>();

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

  /**
   * Write the row of a call whose cost is in hand: known at its amount, missing at zero.
   * @param call - The call.
   * @param call.source - What made it.
   * @param call.model - The model it called.
   * @param call.upstream - The upstream that served it.
   * @param cost - Its cost, known or missing.
   * @param requestCount - The requests the row counts, or null.
   * @param costIdentity - Its stable identity, or null.
   */
  const appendCall = (call: { source: UsageSource; model: string; upstream: string }, cost: Exclude<Cost, { state: "pending" }>, requestCount: number | null, costIdentity: string | null): void => {
    const costUsd = cost.state === "known" ? cost.usd : 0;
    append({
      ...base,
      source: call.source,
      model: call.model,
      provider: call.upstream,
      inputTokens: cost.tokens?.input ?? null,
      cachedInputTokens: cost.tokens?.cachedInput ?? null,
      outputTokens: cost.tokens?.output ?? null,
      reasoningTokens: cost.tokens?.reasoning ?? null,
      requestCount,
      costUsd,
      costSource: cost.state === "known" ? SOURCE_OF[cost.source] : "missing",
      credits: creditsForUsd(costUsd, multiplier),
      costIdentity,
    });
  };

  return {
    operation: base,
    recordModelCall(call) {
      if (call.cost.state === "pending") {
        lookups.set(JSON.stringify(call.cost.lookup), { lookup: call.cost.lookup, source: call.source, model: call.model });
        return;
      }
      appendCall(call, call.cost, call.requests ?? null, call.costIdentity ?? null);
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
        costIdentity: null,
      });
    },
    recordLookedUpCall(call) {
      // A lookup answers only after its last attempt, so a pending answer is one that never came: missing.
      const cost = call.cost.state === "pending" ? { state: "missing" as const, reason: "the lookup never answered" } : call.cost;
      appendCall(call, cost, 1, null);
    },
    awaitingLookup() {
      return [...lookups.values()];
    },
    async settle() {
      await Promise.all(pending);
      if (failures.length > 0) throw failures[0];
      return toChargeCredits(credits);
    },
    async settleForCharge() {
      await Promise.all(pending);
      return { credits: toChargeCredits(credits), writeFailures: [...failures] };
    },
  };
}
