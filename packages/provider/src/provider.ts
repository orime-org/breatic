// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import {
  assertBindsCatalog,
  candidatesOf,
  droppedValues,
  parseProviderConfig,
  type CatalogShape,
  type ProviderConfig,
  type MediaBinding,
  type ProviderConfigInput,
} from "@provider/config/schema.js";
import type { Cost, CostLookup } from "@provider/cost.js";
import { sideBounds } from "@provider/http/request.js";
import type { LlmApi } from "@provider/llm/api.js";
import { createLlm } from "@provider/llm/llm.js";
import { hasLlmAdapter, vendorOf } from "@provider/llm/vendors.js";
import { mediaAdapter } from "@provider/media/adapters.js";
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
  /** Applied to the question of an understand call and to every string and key of a decisions request; a prepared call's messages go to the upstream as the caller built them. */
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
  const pricingRules = (model: string): PricingRules => ({
    model,
    ...(config.rejects[model] === undefined ? {} : { rejects: config.rejects[model] }),
    upstreams: (config.models[model] ?? []).map(pricingOf),
  });
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
      kind: step.kind,
      ...(step.for_param === undefined ? {} : { for_param: step.for_param }),
      ...(step.per_item === undefined ? {} : { per_item: step.per_item }),
      ...(step.pricing === undefined ? {} : { pricing: step.pricing as PricingRule }),
    })),
    ...(binding.reused_by === undefined ? {} : { reused_by: binding.reused_by }),
    ...limitsOf(binding),
    ...(binding.rejects === undefined ? {} : { rejects: binding.rejects }),
    ...(binding.mentions === undefined ? {} : { mentions: binding.mentions }),
  };
}

/**
 * The input limits a binding puts on a run: each param's supported values or the values a drop serves, and each voice map's voices.
 * @param binding - The binding.
 * @returns The limits and voices, each left out when empty.
 */
function limitsOf(binding: MediaBinding): Pick<UpstreamPricing, "limits" | "voices"> {
  const limits: NonNullable<UpstreamPricing["limits"]> = {};
  for (const [param, bound] of Object.entries(binding.params ?? {})) {
    if (bound.supported !== undefined) limits[param] = bound.supported;
  }
  for (const [param, drop] of Object.entries(binding.drops ?? {})) {
    const values = droppedValues(drop);
    if (values !== undefined) limits[param] = [...values];
  }
  const voices = Object.fromEntries(Object.entries(binding.voice_map ?? {}).map(([param, map]) => [param, Object.keys(map)]));
  return {
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(Object.keys(voices).length === 0 ? {} : { voices }),
  };
}

/**
 * Ask the upstream again for a cost that was pending: an LLM upstream that reports its costs
 * by generation id, a media upstream through its adapter. Until the last attempt an
 * unanswered lookup stays pending; on it, it is missing.
 * @param config - The validated configuration.
 * @param options - The caller's options.
 * @param lookup - The handle.
 * @param lastAttempt - Whether no later lookup follows.
 * @returns The cost.
 */
async function lookupCost(config: ProviderConfig, options: ProviderOptions, lookup: CostLookup, lastAttempt: boolean): Promise<Cost> {
  const decl = config.upstreams[lookup.upstream];
  if (decl === undefined) return { state: "missing", reason: `unknown upstream ${lookup.upstream}` };
  const key = options.keyOf(decl.key_env) ?? "";
  const media = mediaAdapter(decl.kind);
  if (media !== undefined && typeof lookup.predictionId === "string") {
    return (await media.billed({ name: lookup.upstream, decl, key }, lookup.predictionId, sideBounds(), lastAttempt)).cost;
  }
  const costs = hasLlmAdapter(decl.kind) ? vendorOf(decl.kind).costs : undefined;
  if (costs === undefined || typeof lookup.generationId !== "string") return { state: "missing", reason: "the lookup names nothing to ask" };
  return costs.lookup(decl, key, lookup.generationId, lookup, lastAttempt);
}
