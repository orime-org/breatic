// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  assertBindsCatalog,
  candidatesOf,
  parseProviderConfig,
  type CatalogShape,
  type ProviderConfig,
  type MediaBinding,
  type ProviderConfigInput,
} from "@provider/config/schema.js";
import { z } from "zod";
import { numberLeaf, type Cost, type CostLookup, type TokenBuckets } from "@provider/cost.js";
import { fetchJson, SIDE_REQUEST_MS } from "@provider/http/request.js";
import type { LlmApi } from "@provider/llm/api.js";
import { createLlm } from "@provider/llm/llm.js";
import { billed } from "@provider/media/wavespeed/adapter.js";
import {
  estimateCost,
  type Availability,
  type Estimate,
  type EstimateInput,
  type PricingRule,
  type PricingRules,
  type Route,
  type UpstreamPricing,
} from "@provider/pricing/estimate.js";

/** What the caller hands provider. */
export interface ProviderOptions {
  config: ProviderConfigInput;
  /** Reads one environment variable; undefined or empty means not configured. */
  keyOf: (envName: string) => string | undefined;
  /** Retries on one upstream before an LLM call moves on. */
  llmMaxRetries: number;
  /** Applied to every text provider sends to an LLM. */
  cleanText: (text: string) => string;
}

/** One provider instance. */
export interface Provider {
  /** The validated configuration, deployment overrides applied. */
  readonly config: ProviderConfig;
  /** The caller's key reader. */
  readonly keyOf: (envName: string) => string | undefined;
  /** A model's upstreams in effective weight order, each saying whether its key is configured. */
  availability(model: string): Availability;
  /**
   * Check this instance's bindings against our catalog.
   * @throws {ProviderConfigError} Listing every mismatch.
   */
  assertBindsCatalog(catalog: CatalogShape): void;
  /** A model's pricing on each upstream, for the browser to estimate with. */
  pricingRules(model: string): PricingRules;
  /** The estimate of the upstream the route would choose; null when it reaches none. */
  estimate(model: string, input: EstimateInput, route: Route): Promise<Estimate | null>;
  readonly llm: LlmApi;
  readonly cost: {
    /** Ask the upstream again for a cost that was pending; the last attempt answers known or missing. */
    lookup(lookup: CostLookup, options: { lastAttempt: boolean }): Promise<Cost>;
  };
}

/**
 * Build a provider from the caller's configuration.
 * @param options - Configuration, key reader and the caller's limits.
 * @returns The instance.
 * @throws {ProviderConfigError} When the configuration is invalid.
 */
export function createProvider(options: ProviderOptions): Provider {
  const config = parseProviderConfig(options.config);
  /**
   * A model's upstreams in effective weight order, each with its key state.
   * @param model - Our model id.
   * @returns The availability.
   */
  const availability = (model: string): Availability => ({
    upstreams: candidatesOf(config, model, options.keyOf).map(({ upstream, weight, configured, envVar }) => ({ upstream, weight, configured, envVar })),
  });
  /**
   * A model's pricing on each upstream.
   * @param model - Our model id.
   * @returns The rules.
   */
  const pricingRules = (model: string): PricingRules => ({ model, upstreams: (config.models[model] ?? []).map(pricingOf) });
  return {
    config,
    keyOf: options.keyOf,
    availability,
    assertBindsCatalog: (catalog) => assertBindsCatalog(config, catalog),
    pricingRules,
    estimate: (model, input, route) => estimateCost(pricingRules(model), availability(model), input, route),
    llm: createLlm(config, options),
    cost: { lookup: (lookup, { lastAttempt }) => lookupCost(config, options, lookup, lastAttempt) },
  };
}

/**
 * What the browser needs to price a run on one binding.
 * @param binding - The binding.
 * @returns Its pricing entry.
 */
function pricingOf(binding: MediaBinding): UpstreamPricing {
  return {
    upstream: binding.upstream,
    ...(binding.prompt_field === undefined ? {} : { prompt_field: binding.prompt_field }),
    fields: Object.fromEntries(Object.entries(binding.params ?? {}).map(([param, bound]) => [param, bound.field])),
    pricing: binding.pricing as PricingRule,
    steps: (binding.extra_steps ?? []).map((step) => ({
      ...(step.for_param === undefined ? {} : { for_param: step.for_param }),
      ...(step.per_item === undefined ? {} : { per_item: step.per_item }),
      ...(step.reused === undefined ? {} : { reused: step.reused }),
      ...(step.pricing === undefined ? {} : { pricing: step.pricing as PricingRule }),
    })),
    ...(binding.reused_by === undefined ? {} : { reused_by: binding.reused_by }),
  };
}

/** OpenRouter's generation answer, as far as it is read. */
const generationSchema = z.looseObject({
  data: z.looseObject({
    total_cost: numberLeaf,
    native_tokens_prompt: numberLeaf,
    native_tokens_cached: numberLeaf,
    native_tokens_completion: numberLeaf,
    native_tokens_reasoning: numberLeaf,
  }),
});

/** The largest generation answer read. */
const MAX_LOOKUP_BYTES = 1024 * 1024;

/**
 * Ask the upstream again for a cost that was pending: OpenRouter
 * by generation id, WaveSpeed by its billing search. Until the last attempt an
 * unanswered lookup stays pending; on it, it is missing.
 * @param config - The validated configuration.
 * @param options - The caller's options.
 * @param lookup - The handle.
 * @param lastAttempt - Whether no later lookup follows.
 * @returns The cost.
 */
async function lookupCost(config: ProviderConfig, options: ProviderOptions, lookup: CostLookup, lastAttempt: boolean): Promise<Cost> {
  /**
   * The answer when the upstream did not say: pending, or missing on the last attempt.
   * @param reason - Why.
   * @returns The cost.
   */
  const unanswered = (reason: string): Cost => (lastAttempt ? { state: "missing", reason } : { state: "pending", lookup });
  const decl = config.upstreams[lookup.upstream];
  if (decl === undefined) return { state: "missing", reason: `unknown upstream ${lookup.upstream}` };
  const key = options.keyOf(decl.key_env) ?? "";
  if (decl.kind === "wavespeed" && typeof lookup.predictionId === "string") {
    return (await billed({ name: lookup.upstream, decl, key }, lookup.predictionId, {}, lastAttempt)).cost;
  }
  if (decl.kind !== "openrouter" || typeof lookup.generationId !== "string") return { state: "missing", reason: "the lookup names nothing to ask" };
  try {
    const body = await fetchJson(
      { url: `${decl.base_url}/generation?id=${encodeURIComponent(lookup.generationId)}`, method: "GET", headers: { authorization: `Bearer ${key}` } },
      { replaySafe: true, maxBodyBytes: MAX_LOOKUP_BYTES, idleMs: SIDE_REQUEST_MS },
    );
    const parsed = generationSchema.safeParse(body);
    if (!parsed.success) return unanswered("the generation answer is not shaped as a generation");
    const data = parsed.data.data;
    const tokens: TokenBuckets = {
      input: data.native_tokens_prompt ?? 0,
      cachedInput: data.native_tokens_cached ?? 0,
      output: data.native_tokens_completion ?? 0,
      reasoning: data.native_tokens_reasoning ?? 0,
    };
    const cost = data.total_cost;
    if (cost === undefined) {
      const reason = "the generation carries no cost yet";
      return lastAttempt ? { state: "missing", reason, tokens } : { state: "pending", lookup };
    }
    return { state: "known", usd: cost, tokens, source: "billing" };
  } catch (error) {
    return unanswered(error instanceof Error ? error.message : String(error));
  }
}
