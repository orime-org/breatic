// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one paid call cost us, and what that is in credits (#296).
 *
 * A service that reports its own cost is taken at its word; a model reached
 * directly reports only tokens, and is priced from `config/usage-pricing.yaml`.
 * One credit is one US cent.
 */

import type { UsagePricing } from "@breatic/core";

/** Where a recorded cost came from. */
export type CostSource = "provider" | "price_table" | "generation_lookup" | "missing";

/** The token buckets one model call used. Reasoning is part of output. */
export interface TokenBuckets {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** The AI SDK usage fields this module reads. */
export interface ModelCallUsage {
  inputTokens: number | undefined;
  inputTokenDetails: { noCacheTokens: number | undefined; cacheReadTokens: number | undefined };
  outputTokens: number | undefined;
  outputTokenDetails: { reasoningTokens: number | undefined };
}

/** One finished model call, as `onLanguageModelCallEnd` describes it. */
export interface ModelCall {
  model: string;
  provider: string;
  usage: ModelCallUsage;
  providerMetadata: Record<string, unknown> | undefined;
}

/** What one model call cost. */
export interface ModelCallCost {
  costUsd: number;
  costSource: CostSource;
  tokens: TokenBuckets;
}

/**
 * Read the cost OpenRouter put on a response.
 * @param metadata - The call's provider metadata.
 * @returns The cost in US dollars, or undefined when none was reported.
 */
export function openRouterCost(metadata: Record<string, unknown> | undefined): number | undefined {
  const usage = (metadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage;
  return typeof usage?.cost === "number" ? usage.cost : undefined;
}

/**
 * Split a call's usage into the buckets the prices are quoted in.
 * @param usage - The AI SDK usage.
 * @returns Input, cached input, output and reasoning tokens.
 */
function bucketsOf(usage: ModelCallUsage): TokenBuckets {
  const cachedInput = usage.inputTokenDetails.cacheReadTokens ?? 0;
  return {
    input: usage.inputTokens ?? 0,
    cachedInput,
    output: usage.outputTokens ?? 0,
    reasoning: usage.outputTokenDetails.reasoningTokens ?? 0,
  };
}

/**
 * Work out what one model call cost.
 * @param call - The call's model, route and usage.
 * @param pricing - The prices for calls that report no cost.
 * @returns The cost, where it came from, and the tokens behind it.
 * @throws {Error} When a directly reached model has no price in the table.
 */
export function costOfModelCall(call: ModelCall, pricing: UsagePricing): ModelCallCost {
  const tokens = bucketsOf(call.usage);

  if (call.provider === "openrouter") {
    const reported = openRouterCost(call.providerMetadata);
    return reported === undefined
      ? { costUsd: 0, costSource: "missing", tokens }
      : { costUsd: reported, costSource: "provider", tokens };
  }

  const price = pricing.models[call.model];
  if (!price) {
    throw new Error(
      `No price for ${call.model} in config/usage-pricing.yaml, and ${call.provider} reports no cost`,
    );
  }
  const uncached = tokens.input - tokens.cachedInput;
  const costUsd =
    (uncached * price.input_cache_miss_per_mtok +
      tokens.cachedInput * price.input_cache_hit_per_mtok +
      tokens.output * price.output_per_mtok) /
    1_000_000;
  return { costUsd, costSource: "price_table", tokens };
}

/**
 * Credits for a dollar amount: one credit per cent, times the multiplier.
 * @param costUsd - What the call cost, in US dollars.
 * @param multiplier - `CREDIT_MULTIPLIER`.
 * @returns Credits.
 */
export function creditsForUsd(costUsd: number, multiplier: number): number {
  return costUsd * 100 * multiplier;
}
