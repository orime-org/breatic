// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { isPricingRule } from "@provider/pricing/estimate.js";
import type { Candidate } from "@provider/routing/route.js";

const choice = z.union([z.string(), z.number(), z.boolean()]);
const weights = z.record(z.string(), z.number().int().min(0));
const weighted = z.object({ upstream: z.string(), weight: z.number().int().min(0) });

/**
 * A pricing rule provider can evaluate. Kept as `unknown` in the types, so a
 * caller's yaml reads in as it is; the check runs at load.
 */
const pricingRule = z.custom<unknown>((value) => isPricingRule(value), { message: "is not a valid pricing rule" });

const upstreamSchema = z.object({
  kind: z.string().min(1),
  base_url: z.string().min(1),
  key_env: z.string().min(1),
  concurrency: z.number().int().positive().optional(),
});

const paramSchema = z.object({
  field: z.string().min(1),
  /** Our value to the upstream's spelling. */
  values: z.record(z.string(), choice).optional(),
  /** Each list entry is wrapped under this key. */
  item_key: z.string().optional(),
  /** Holding this value sends nothing. */
  absent_value: choice.optional(),
  /** `pronunciation_pairs` writes `{ text, pronunciation }` items as `text/pronunciation` strings. */
  transform: z.literal("pronunciation_pairs").optional(),
});

const describeSchema = z.object({
  /** Our LLM model id, routed by `understand_routes`. */
  model: z.string().min(1),
  question: z.string().min(1),
  max_output_tokens: z.number().int().positive(),
});

const extraStepSchema = z.object({
  kind: z.enum(["upload_reference", "upload_melody", "vocal", "element", "speak"]),
  endpoint: z.string().min(1),
  at: z.enum(["before", "after"]),
  /** The param it serves; the step is skipped when the param carries nothing. */
  for_param: z.string().optional(),
  /** One step per item of the param. */
  per_item: z.boolean().optional(),
  /** For an element step: how its reference image is described first. */
  describe: describeSchema.optional(),
  /** What one call of this step costs. */
  pricing: pricingRule.optional(),
  /** The step is skipped on a later run whose source it already made a clone of. */
  reused: z.boolean().optional(),
});

// Every binding carries its price (design 4.2): the cheapest mode and the
// estimate both read it, and the shipped bindings all have one.
const bindingSchema = z.object({
  upstream: z.string().min(1),
  weight: z.number().int().min(0),
  model_id: z.string().min(1),
  prompt_field: z.string().optional(),
  params: z.record(z.string(), paramSchema).optional(),
  extra_steps: z.array(extraStepSchema).optional(),
  /** The param a clone made by this binding is reused by; the model's own call is then a clone. */
  reused_by: z.string().optional(),
  mentions: z.record(z.string(), z.string()).optional(),
  voice_map: z.record(z.string(), z.string()).optional(),
  pricing: pricingRule,
});

const llmRouteSchema = z.object({ prefix: z.string(), upstreams: z.array(weighted) });

const llmPriceSchema = z.object({
  input_cache_miss_per_mtok: z.number().min(0),
  input_cache_hit_per_mtok: z.number().min(0).optional(),
  input_cache_write_5m_per_mtok: z.number().min(0).optional(),
  input_cache_write_1h_per_mtok: z.number().min(0).optional(),
  output_per_mtok: z.number().min(0),
});

const llmSchema = z.object({
  routes: z.array(llmRouteSchema),
  understand_routes: z.array(llmRouteSchema).optional(),
  vendor_ids: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  openrouter_backends: z.record(z.string(), z.object({ only: z.array(z.string()), allow_fallbacks: z.boolean() })).optional(),
  /** Direct token prices in USD per million tokens, by our model id. */
  prices: z.record(z.string(), llmPriceSchema).optional(),
});

const routingSchema = z.object({
  models: z.record(z.string(), z.object({ weights })).optional(),
  llm: z.record(z.string(), z.object({ weights })).optional(),
});

const inputSchema = z.object({
  upstreams: z.record(z.string(), upstreamSchema),
  media: z.object({ models: z.record(z.string(), z.object({ upstreams: z.array(bindingSchema) })) }),
  /** `config/provider/llm.yaml` (design 4.3). */
  llm: llmSchema.optional(),
  /** `config/provider/routing.yaml`; absent when the deployment ships none. */
  routing: routingSchema.optional(),
});

/** One upstream as `config/provider/upstreams.yaml` declares it. */
export type UpstreamDecl = z.infer<typeof upstreamSchema>;
/** How one of our params is written for one upstream. */
export type ParamBinding = z.infer<typeof paramSchema>;
/** What the element step asks the understand model to write about each reference image. */
export type DescribeBinding = z.infer<typeof describeSchema>;
/** One extra upstream call of a binding, before or after the model's own call (design 4.2, 6.2). */
export type ExtraStepBinding = z.infer<typeof extraStepSchema>;
/** One model bound to one upstream (design 4.2). */
export type MediaBinding = z.infer<typeof bindingSchema>;
/** The raw provider configuration, as read from the yaml files by the caller. */
export type ProviderConfigInput = z.input<typeof inputSchema>;
/** The deployment's weight overrides (design 4.4): per media model, and per LLM route prefix. */
export type RoutingOverride = z.infer<typeof routingSchema>;
/** One LLM route: the first whose prefix matches a model id wins. */
export type LlmRoute = z.infer<typeof llmRouteSchema>;
/** The LLM routing file (design 4.3). */
export type LlmConfigInput = z.infer<typeof llmSchema>;
/** One model's direct token prices, USD per million tokens. */
export type LlmPrice = z.infer<typeof llmPriceSchema>;

/** The validated configuration, with deployment overrides applied. */
export interface ProviderConfig {
  upstreams: Record<string, UpstreamDecl>;
  models: Record<string, MediaBinding[]>;
  llm: Required<Pick<LlmConfigInput, "routes" | "understand_routes" | "vendor_ids" | "openrouter_backends" | "prices">>;
}

/** The catalog facts a binding is checked against: each model's params and the values each offers. */
export interface CatalogShape {
  models: { name: string; params: Record<string, { values?: (string | number | boolean)[] }> }[];
}

/** Every problem found while loading the provider configuration, one line each. */
export class ProviderConfigError extends Error {
  readonly problems: readonly string[];

  /**
   * Record what the error carries.
   * @param problems - One line per problem.
   */
  constructor(problems: readonly string[]) {
    super(`Provider configuration is invalid:\n${problems.join("\n")}`);
    this.name = "ProviderConfigError";
    this.problems = problems;
  }
}

/**
 * Apply one override to a list of weighted upstreams, reporting names it does not bind.
 * @param owner - What the list belongs to, for the problem line.
 * @param list - The upstreams and their default weights.
 * @param override - The deployment's weights, by upstream.
 * @param problems - Where problems go.
 * @returns The list with the overridden weights.
 */
function overridden<T extends { upstream: string; weight: number }>(
  owner: string,
  list: T[],
  override: Record<string, number> | undefined,
  problems: string[],
): T[] {
  if (override === undefined) return list;
  for (const name of Object.keys(override)) {
    if (!list.some((u) => u.upstream === name)) problems.push(`${owner}: the override names upstream "${name}", which it is not bound to`);
  }
  return list.map((u) => (override[u.upstream] === undefined ? u : { ...u, weight: override[u.upstream]! }));
}

/**
 * Report weights used twice and upstreams upstreams.yaml does not declare.
 * @param owner - What the list belongs to.
 * @param list - The upstreams with effective weights.
 * @param declared - The declared upstreams.
 * @param problems - Where problems go.
 */
function checkList(owner: string, list: { upstream: string; weight: number }[], declared: Record<string, UpstreamDecl>, problems: string[]): void {
  const seen = new Set<number>();
  for (const { weight } of list) {
    if (seen.has(weight)) problems.push(`${owner}: weight ${weight} is used by more than one upstream`);
    seen.add(weight);
  }
  for (const { upstream } of list) {
    if (declared[upstream] === undefined) problems.push(`${owner}: upstream "${upstream}" is not declared in upstreams.yaml`);
  }
}

/**
 * One schema problem as a line naming the model and upstream it is about.
 * @param input - The raw files.
 * @param path - Where the problem is.
 * @param message - What is wrong.
 * @returns The line.
 */
function issueLine(input: ProviderConfigInput, path: readonly PropertyKey[], message: string): string {
  const [media, models, model, upstreams, index, ...rest] = path;
  if (media === "media" && models === "models" && upstreams === "upstreams" && typeof index === "number") {
    const upstream = (input.media.models[String(model)]?.upstreams[index] as { upstream?: unknown } | undefined)?.upstream;
    return `${String(model)}: the binding to "${String(upstream)}": ${rest.map(String).join(".")} ${message}`;
  }
  return `${path.map(String).join(".")}: ${message}`;
}

/**
 * Validate the configuration and apply the deployment's weight overrides.
 * @param input - The raw files.
 * @returns The validated configuration.
 * @throws {ProviderConfigError} Listing every problem found.
 */
export function parseProviderConfig(input: ProviderConfigInput): ProviderConfig {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ProviderConfigError(parsed.error.issues.map((issue) => issueLine(input, issue.path, issue.message)));
  const raw = parsed.data;
  const problems: string[] = [];
  const models: Record<string, MediaBinding[]> = {};
  for (const [model, { upstreams }] of Object.entries(raw.media.models)) {
    const bindings = overridden(model, upstreams, raw.routing?.models?.[model]?.weights, problems);
    checkList(model, bindings, raw.upstreams, problems);
    models[model] = [...bindings].sort((a, b) => a.weight - b.weight);
  }
  for (const name of Object.keys(raw.routing?.models ?? {})) {
    if (models[name] === undefined) problems.push(`${name}: the override names a model that has no bindings`);
  }
  /**
   * One LLM route with the deployment's weights, its problems reported.
   * @param route - The route.
   * @param label - What problems call it.
   * @returns The route with effective weights, lowest first.
   */
  const llmRoute = (route: LlmRoute, label: string): LlmRoute => {
    const upstreams = overridden(label, route.upstreams, raw.routing?.llm?.[route.prefix]?.weights, problems);
    checkList(label, upstreams, raw.upstreams, problems);
    return { prefix: route.prefix, upstreams: [...upstreams].sort((a, b) => a.weight - b.weight) };
  };
  const llm: ProviderConfig["llm"] = {
    routes: (raw.llm?.routes ?? []).map((r) => llmRoute(r, `LLM route "${r.prefix}"`)),
    understand_routes: (raw.llm?.understand_routes ?? []).map((r) => llmRoute(r, `LLM understand route "${r.prefix}"`)),
    vendor_ids: raw.llm?.vendor_ids ?? {},
    openrouter_backends: raw.llm?.openrouter_backends ?? {},
    prices: raw.llm?.prices ?? {},
  };
  for (const prefix of Object.keys(raw.routing?.llm ?? {})) {
    if (!llm.routes.some((r) => r.prefix === prefix)) problems.push(`LLM route "${prefix}": the override names a prefix no route has`);
  }
  if (problems.length > 0) throw new ProviderConfigError(problems);
  return { upstreams: raw.upstreams, models, llm };
}

/**
 * Whether a key is configured.
 * @param keyOf - Reads one environment variable.
 * @param env - The variable.
 * @returns True when it holds a non-empty value.
 */
export function hasKey(keyOf: (env: string) => string | undefined, env: string): boolean {
  const value = keyOf(env);
  return value !== undefined && value !== "";
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
  const bindings = config.models[model];
  if (bindings === undefined) throw new Error(`Model ${model} has no upstream bindings`);
  return bindings.map((b) => candidateOf(config, b.upstream, b.weight, keyOf));
}

/**
 * One upstream as a routing candidate.
 * @param config - The validated configuration.
 * @param upstream - The upstream.
 * @param weight - Its effective weight.
 * @param keyOf - Reads one environment variable.
 * @returns The candidate.
 */
export function candidateOf(config: ProviderConfig, upstream: string, weight: number, keyOf: (env: string) => string | undefined): Candidate {
  const envVar = config.upstreams[upstream]!.key_env;
  return { upstream, weight, configured: hasKey(keyOf, envVar), envVar };
}

/**
 * Check every binding against our catalog (design 4.2, R11).
 * @param config - The validated configuration.
 * @param catalog - Our models and their params.
 * @throws {ProviderConfigError} Listing every mismatch.
 */
export function assertBindsCatalog(config: ProviderConfig, catalog: CatalogShape): void {
  const problems: string[] = [];
  for (const { name, params } of catalog.models) {
    const bindings = config.models[name];
    if (bindings === undefined || bindings.length === 0) {
      problems.push(`${name}: the catalog model has no upstream binding`);
      continue;
    }
    for (const binding of bindings) {
      for (const [param, bound] of Object.entries(binding.params ?? {})) {
        const declared = params[param];
        if (declared === undefined) {
          problems.push(`${name}: "${binding.upstream}" binds param "${param}", which the model does not have`);
          continue;
        }
        if (declared.values === undefined) continue;
        const offered = new Set(declared.values.map(String));
        for (const value of Object.keys(bound.values ?? {})) {
          if (!offered.has(value)) problems.push(`${name}: "${binding.upstream}" maps value "${value}" of "${param}", which the param does not offer`);
        }
        if (bound.absent_value !== undefined && !offered.has(String(bound.absent_value))) {
          problems.push(`${name}: "${binding.upstream}" sends nothing for value "${String(bound.absent_value)}" of "${param}", which the param does not offer`);
        }
      }
    }
  }
  if (problems.length > 0) throw new ProviderConfigError(problems);
}
