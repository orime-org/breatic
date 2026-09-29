// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every model the agent can run on has a way to be priced (#296).
 *
 * A model reached through OpenRouter reports what each call cost. One reached
 * directly reports only tokens, and is priced from `config/usage-pricing.yaml`;
 * without a price there, its first call would fail after the money was spent.
 * So the services check at startup, where whoever edited the config is
 * watching.
 */

import { getAgentConfig, getUsagePricing, type UsagePricing } from "@breatic/core";
import { resolveProvider } from "@domain/agent/llm.js";
import { getSkillRegistry } from "@domain/agent/skills-loader.js";

/** What the check reads; injected in tests. */
export interface PriceCheckSources {
  pricing: UsagePricing;
  providerOf: (model: string) => string;
}

/**
 * The models the agent's own paths run on: the chat default, memory
 * consolidation, and every model a skill pins.
 * @returns Each model id once.
 */
export function agentModelIds(): string[] {
  const config = getAgentConfig();
  const registry = getSkillRegistry();
  const pinned = registry
    .list()
    .map((skill) => registry.getInternal(skill.name)?.model)
    .filter((model): model is string => typeof model === "string");
  return [...new Set([config.default_model, config.consolidation_model, ...pinned])];
}

/**
 * Refuse to run when a directly reached model has no price.
 * @param models - The models this process can run on.
 * @param sources - The price table and the routing; the live ones by default.
 * @throws {Error} Naming every model that has no price.
 */
export function assertModelsPriced(
  models: readonly string[],
  sources: PriceCheckSources = { pricing: getUsagePricing(), providerOf: resolveProvider },
): void {
  const unpriced = [...new Set(models)].filter(
    (model) => sources.providerOf(model) !== "openrouter" && !sources.pricing.models[model],
  );
  if (unpriced.length > 0) {
    throw new Error(
      `No price in config/usage-pricing.yaml for ${unpriced.join(", ")}, ` +
        "which this deployment reaches directly and which report no cost of their own",
    );
  }
}
