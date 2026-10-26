// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProviderConfigInput } from "@provider/config/schema.js";
import type { Cost, CostLookup } from "@provider/cost.js";
import type { LlmApi } from "@provider/llm/api.js";
import type { Availability, Estimate, EstimateInput, PricingRules, Route } from "@provider/pricing/estimate.js";

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
  void options;
  throw new Error("createProvider is not implemented");
}
