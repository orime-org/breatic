// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Candidate } from "@provider/routing/route.js";

/** One upstream as `config/provider/upstreams.yaml` declares it. */
export interface UpstreamDecl {
  kind: string;
  base_url: string;
  key_env: string;
  concurrency?: number;
}

/** How one of our params is written for one upstream. */
export interface ParamBinding {
  field: string;
  values?: Record<string, string | number | boolean>;
  item_key?: string;
  absent_value?: string | number | boolean;
}

/** One model bound to one upstream (design 4.2). */
export interface MediaBinding {
  upstream: string;
  weight: number;
  model_id: string;
  prompt_field?: string;
  params?: Record<string, ParamBinding>;
  extra_steps?: unknown[];
  mentions?: Record<string, string>;
  voice_map?: Record<string, string>;
  pricing: unknown;
}

/** The raw provider configuration, as read from the yaml files by the caller. */
export interface ProviderConfigInput {
  upstreams: Record<string, UpstreamDecl>;
  media: { models: Record<string, { upstreams: MediaBinding[] }> };
  /** `config/provider/routing.yaml`; absent when the deployment ships none. */
  routing?: { models?: Record<string, { weights: Record<string, number> }> };
}

/** The validated configuration, with deployment overrides applied. */
export interface ProviderConfig {
  upstreams: Record<string, UpstreamDecl>;
  models: Record<string, MediaBinding[]>;
}

/** The catalog facts a binding is checked against: each model's params and the values each offers. */
export interface CatalogShape {
  models: { name: string; params: Record<string, { values?: (string | number | boolean)[] }> }[];
}

/** Every problem found while loading the provider configuration, one line each. */
export class ProviderConfigError extends Error {
  readonly problems: readonly string[];

  /**
   * @param problems - One line per problem.
   */
  constructor(problems: readonly string[]) {
    super(`Provider configuration is invalid:\n${problems.join("\n")}`);
    this.name = "ProviderConfigError";
    this.problems = problems;
  }
}

/**
 * Validate the configuration and apply the deployment's weight overrides.
 * @param input - The raw files.
 * @returns The validated configuration.
 * @throws {ProviderConfigError} Listing every problem found.
 */
export function parseProviderConfig(input: ProviderConfigInput): ProviderConfig {
  void input;
  throw new Error("parseProviderConfig is not implemented");
}

/**
 * The routing candidates of one model in this deployment.
 * @param config - The validated configuration.
 * @param model - Our model id.
 * @param keyOf - Reads one environment variable; undefined or empty means not configured.
 * @returns One candidate per binding, with effective weights.
 * @throws {Error} When the model has no bindings.
 */
export function candidatesOf(config: ProviderConfig, model: string, keyOf: (env: string) => string | undefined): Candidate[] {
  void config; void model; void keyOf;
  throw new Error("candidatesOf is not implemented");
}

/**
 * Check every binding against our catalog (design 4.2, R11).
 * @param config - The validated configuration.
 * @param catalog - Our models and their params.
 * @throws {ProviderConfigError} Listing every mismatch.
 */
export function assertBindsCatalog(config: ProviderConfig, catalog: CatalogShape): void {
  void config; void catalog;
  throw new Error("assertBindsCatalog is not implemented");
}
