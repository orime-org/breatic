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
  /** A rewrite of the value into the upstream's own shape; `pronunciation_pairs` writes `{ text, pronunciation }` items as `text/pronunciation` strings. */
  transform?: "pronunciation_pairs";
}

/** What the element step asks the understand model to write about each reference image. */
export interface DescribeBinding {
  /** Our LLM model id, routed by `understand_routes`. */
  model: string;
  question: string;
  max_output_tokens: number;
}

/** One extra upstream call of a binding, before or after the model's own call (design 4.2, 6.2). */
export interface ExtraStepBinding {
  kind: "upload_reference" | "upload_melody" | "vocal" | "element" | "speak";
  endpoint: string;
  at: "before" | "after";
  /** The param it serves; the step is skipped when the param carries nothing. */
  for_param?: string;
  /** One step per item of the param. */
  per_item?: boolean;
  /** For an element step: how its reference image is described first. */
  describe?: DescribeBinding;
}

/** One model bound to one upstream (design 4.2). */
export interface MediaBinding {
  upstream: string;
  weight: number;
  model_id: string;
  prompt_field?: string;
  params?: Record<string, ParamBinding>;
  extra_steps?: ExtraStepBinding[];
  /** The param a clone made by this binding is reused by; the model's own call is then a clone. */
  reused_by?: string;
  mentions?: Record<string, string>;
  voice_map?: Record<string, string>;
  pricing: unknown;
}

/** The raw provider configuration, as read from the yaml files by the caller. */
export interface ProviderConfigInput {
  upstreams: Record<string, UpstreamDecl>;
  media: { models: Record<string, { upstreams: MediaBinding[] }> };
  /** `config/provider/llm.yaml` (design 4.3). */
  llm?: LlmConfigInput;
  /** `config/provider/routing.yaml`; absent when the deployment ships none. */
  routing?: { models?: Record<string, { weights: Record<string, number> }> };
}

/** One LLM route: the first whose prefix matches a model id wins. */
export interface LlmRoute {
  prefix: string;
  upstreams: { upstream: string; weight: number }[];
}

/** The LLM routing file (design 4.3). */
export interface LlmConfigInput {
  routes: LlmRoute[];
  understand_routes?: LlmRoute[];
  vendor_ids?: Record<string, Record<string, string>>;
  openrouter_backends?: Record<string, { only: string[]; allow_fallbacks: boolean }>;
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
