// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { candidatesOf, parseProviderConfig, type MediaBinding, type ProviderConfigInput } from "@provider/config/schema.js";
import type { Cost, CostLookup } from "@provider/cost.js";
import type { LlmApi } from "@provider/llm/api.js";
import { createLlm } from "@provider/llm/llm.js";
import { lookupCost } from "@provider/llm/costs.js";
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

/** What the caller hands provider (design 3.1). */
export interface ProviderOptions {
  config: ProviderConfigInput;
  /** Reads one environment variable; undefined or empty means not configured. */
  keyOf: (envName: string) => string | undefined;
  /** Retries on one upstream before an LLM call moves on. */
  llmMaxRetries: number;
  /** Applied to every text provider sends to an LLM. */
  cleanText: (text: string) => string;
}

/** One provider instance (design 3). */
export interface Provider {
  readonly options: ProviderOptions;
  /** A model's upstreams in effective weight order, each saying whether its key is configured. */
  availability(model: string): Availability;
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
  const availability = (model: string): Availability => ({
    upstreams: candidatesOf(config, model, options.keyOf).map(({ upstream, weight, configured, envVar }) => ({ upstream, weight, configured, envVar })),
  });
  const pricingRules = (model: string): PricingRules => ({ model, upstreams: (config.models[model] ?? []).map(pricingOf) });
  return {
    options,
    availability,
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
