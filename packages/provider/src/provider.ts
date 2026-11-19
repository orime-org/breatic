// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import { checkKey, type KeyCheck } from "@provider/check-key.js";
import type { Cost, CostLookup } from "@provider/cost.js";
import { sideBounds } from "@provider/http/request.js";
import type { LlmApi } from "@provider/llm/api.js";
import { createLlm } from "@provider/llm/llm.js";
import { hasLlmAdapter, vendorOf } from "@provider/llm/vendors.js";
import { deploymentKeySet, keyFor, lookupOwner, paidOn, recordedKeys, type KeySet } from "@provider/keys.js";
import { mediaAdapter } from "@provider/media/adapters.js";
import {
  estimateCost,
  inputRefusal,
  type Availability,
  type Estimate,
  type EstimateInput,
  type PricingRule,
  type PricingRules,
  type RejectedInput,
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
  /** The deployment's key set, which a call handed no key set runs on. */
  readonly deploymentKeys: KeySet;
  /** A model's upstreams in effective weight order, each saying whether the key set (the deployment's by default) holds its key. */
  availability(model: string, keys?: KeySet): Availability;
  /**
   * Check this instance's bindings against our catalog.
   * @throws {ProviderConfigError} Listing every mismatch.
   */
  assertBindsCatalog(catalog: CatalogShape): void;
  /** A model's pricing on each upstream, for the browser to estimate with. */
  pricingRules(model: string): PricingRules;
  /** The estimate of the upstream the route would choose on the key set; null when it reaches none. */
  estimate(model: string, input: EstimateInput, route: Route, keys?: KeySet): Promise<Estimate | null>;
  /** Why no upstream the key set holds a key for and the route may use takes the run; null when one does, none is configured or none configured is priced. */
  refusal(model: string, input: EstimateInput, route: Route, keys?: KeySet): Promise<RejectedInput | null>;
  /**
   * Check a key a user filled in for one upstream: whether it reaches the upstream, and what balance it may read. The
   * answer and any error never hold the key.
   * @throws {MalformedKey} When the key is not printable ASCII; nothing is sent.
   * @throws {Error} When the upstream is unknown or provider cannot check its keys.
   */
  checkKey(upstream: string, key: string): Promise<KeyCheck>;
  readonly llm: LlmApi;
  readonly cost: {
    /**
     * Ask the upstream again for a cost that was pending, with the keys of the owner that ran the call (the deployment's
     * by default); the last attempt answers known or missing.
     * @throws {Error} When the keys are another owner's than the lookup recorded.
     */
    lookup(lookup: CostLookup, options: { lastAttempt: boolean; keys?: KeySet }): Promise<Cost>;
    /**
     * The lookup of a generation queued before lookups named their upstream: the first upstream that keeps
     * generations to look a cost up by, or undefined when none does.
     */
    fromGeneration(generationId: string): CostLookup | undefined;
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
  const deploymentKeys = deploymentKeySet(config, options.keyOf);
  /**
   * A model's upstreams in effective weight order, each with its key state.
   * @param model - Our model id.
   * @param keys - The key set; the deployment's when absent.
   * @returns The availability.
   */
  const availability = (model: string, keys?: KeySet): Availability => ({
    upstreams: candidatesOf(config, model, keys ?? deploymentKeys).map(({ upstream, weight, configured, envVar }) => ({ upstream, weight, configured, envVar })),
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
    deploymentKeys,
    availability,
    assertBindsCatalog: (catalog) => assertBindsCatalog(config, catalog),
    pricingRules,
    estimate: (model, input, route, keys) => estimateCost(pricingRules(model), availability(model, keys), input, route),
    refusal: (model, input, route, keys) => inputRefusal(pricingRules(model), availability(model, keys), input, route),
    checkKey: (upstream, key) => checkKey(config, upstream, key),
    llm: createLlm(config, options, deploymentKeys),
    cost: {
      lookup: async (lookup, { lastAttempt, keys }) => {
        const owned = recordedKeys(lookupOwner(lookup), keys, deploymentKeys, `call ${lookup.upstream} billed`);
        return paidOn(owned)(await lookupCost(config, owned, lookup, lastAttempt));
      },
      fromGeneration(generationId) {
        const upstream = Object.keys(config.upstreams).find((u) => hasLlmAdapter(config.upstreams[u]!.kind) && vendorOf(config.upstreams[u]!.kind).costs !== undefined);
        return upstream === undefined ? undefined : { upstream, generationId };
      },
    },
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
      ...(step.describe === undefined ? {} : { describes: true }),
      ...(step.pricing === undefined ? {} : { pricing: step.pricing as PricingRule }),
    })),
    ...(binding.reused_by === undefined ? {} : { reused_by: binding.reused_by }),
    ...limitsOf(binding),
    ...(binding.rejects === undefined ? {} : { rejects: binding.rejects }),
    ...(binding.dialogue === undefined ? {} : { dialogue: binding.dialogue }),
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
 * @param keys - The keys of the owner that ran the call.
 * @param lookup - The handle.
 * @param lastAttempt - Whether no later lookup follows.
 * @returns The cost.
 */
async function lookupCost(config: ProviderConfig, keys: KeySet, lookup: CostLookup, lastAttempt: boolean): Promise<Cost> {
  const decl = config.upstreams[lookup.upstream];
  if (decl === undefined) return { state: "missing", reason: `unknown upstream ${lookup.upstream}` };
  const key = keyFor(keys, lookup.upstream);
  const media = mediaAdapter(decl.kind);
  if (media !== undefined && typeof lookup.predictionId === "string") {
    return (await media.billed({ name: lookup.upstream, decl, key, owner: keys.owner }, lookup.predictionId, sideBounds(), lastAttempt)).cost;
  }
  const costs = hasLlmAdapter(decl.kind) ? vendorOf(decl.kind).costs : undefined;
  if (costs === undefined || typeof lookup.generationId !== "string") return { state: "missing", reason: "the lookup names nothing to ask" };
  return costs.lookup(decl, key, lookup.generationId, lookup, lastAttempt);
}
