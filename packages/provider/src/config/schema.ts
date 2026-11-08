// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { hasUnderstandAdapter } from "@provider/llm/understand/dispatch.js";
import { hasLlmAdapter } from "@provider/llm/vendors.js";
import { mediaAdapter } from "@provider/media/adapters.js";
import { pricingRuleSchema, rejectSchema, vendorRejectSchema, type Reject } from "@provider/pricing/estimate.js";
import { formulaProblem } from "@provider/pricing/evaluate.js";
import type { Candidate } from "@provider/routing/route.js";

const choice = z.union([z.string(), z.number(), z.boolean()]);
const weights = z.record(z.string(), z.number().int().min(0));
const weighted = z.strictObject({ upstream: z.string(), weight: z.number().int().min(0) });

/**
 * A pricing rule provider can evaluate, checked against pricing's one schema at load (an
 * unknown key refused by name) and kept as `unknown` in the types so a caller's yaml reads in
 * as it is; its readers take it as a PricingRule.
 */
const pricingRule = z.unknown().pipe(pricingRuleSchema).transform((rule): unknown => rule);

/** How long a SandBase run answered completed without outputs is waited for by default, in ms. */
const EMPTY_OUTPUT_WAIT_MS = 600_000;

const upstreamSchema = z.strictObject({
  kind: z.string().min(1),
  base_url: z.string().min(1),
  key_env: z.string().min(1),
  concurrency: z.number().int().positive().optional(),
  /** Where the upstream answers billing questions, when that is not `base_url`; a fal upstream needs its platform API here. */
  billing_url: z.string().min(1).optional(),
  /** How long a run answered completed without outputs may still be storing them, in ms; SandBase reads it. */
  empty_output_wait_ms: z.number().int().positive().default(EMPTY_OUTPUT_WAIT_MS),
});

/** How a written value is converted after its spelling: to a string, a number, or a one-item list. */
const conversion = z.enum(["string", "number", "list"]);

/** How one sub-field of an item of a list param is written. */
const itemFieldSchema = z.strictObject({
  field: z.string().min(1),
  values: z.record(z.string(), choice).optional(),
  as: conversion.optional(),
});

const paramSchema = z.strictObject({
  /** The upstream field; dots write it under nested objects. */
  field: z.string().min(1),
  /** Our value to the upstream's spelling. */
  values: z.record(z.string(), choice).optional(),
  as: conversion.optional(),
  /** The only values of ours this upstream takes; any other keeps it out of the candidates. */
  supported: z.array(choice).optional(),
  /** For a list of items: how each item's sub-fields are written; sub-fields not named are left out. */
  item_fields: z.record(z.string(), itemFieldSchema).optional(),
  /** Each list entry is wrapped under this key. */
  item_key: z.string().optional(),
  /** Holding this value sends nothing. */
  absent_value: choice.optional(),
  /** Written to the field when the run's value is null or absent, where the upstream's own default differs from leaving it out elsewhere. */
  unset: choice.optional(),
  /** `pronunciation_pairs` writes `{ text, pronunciation }` items as `text/pronunciation` strings. */
  transform: z.literal("pronunciation_pairs").optional(),
});

const describeSchema = z.strictObject({
  /** Our LLM model id, routed by `understand_routes`. */
  model: z.string().min(1),
  question: z.string().min(1),
  max_output_tokens: z.number().int().positive(),
});

const extraStepSchema = z.strictObject({
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
});

// Every binding carries its price: the cheapest mode and the
// estimate both read it, and the shipped bindings all have one.
const bindingSchema = z.strictObject({
  upstream: z.string().min(1),
  weight: z.number().int().min(0),
  model_id: z.string().min(1),
  prompt_field: z.string().optional(),
  /** Empty values are sent as they are, the prompt under `prompt_field` included; only null and absent ones are left out. */
  send_empty: z.boolean().optional(),
  params: z.record(z.string(), paramSchema).optional(),
  extra_steps: z.array(extraStepSchema).optional(),
  /** The param a clone made by this binding is reused by; the model's own call is then a clone. */
  reused_by: z.string().optional(),
  mentions: z.record(z.string(), z.string()).optional(),
  /** Per param holding voices: our voice id to this upstream's; a voice not listed keeps the upstream out of the candidates. */
  voice_map: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /** Upstream fields sent with the same value on every call. */
  fixed: z.record(z.string(), z.unknown()).optional(),
  /**
   * Our params this upstream has no field for, and when it can still serve a run:
   * `"*"` whatever the value, a list of values that send nothing (`[false]`, `[""]`, `[]`: only when the run leaves
   * the param out or sets one of them), `{ values, equivalent }` for those values, with why the upstream's default
   * gives them (the catalog check refuses a bare list of any other value), `{ all_values }` whatever the value, for
   * the reason given.
   */
  drops: z.record(z.string(), z.union([
    z.literal("*"),
    z.array(choice),
    z.strictObject({ values: z.array(choice).min(1), equivalent: z.string().min(1) }),
    z.strictObject({ all_values: z.string().min(1) }),
  ])).optional(),
  /** Where a fal result puts its output files, as a dotted path. */
  output_field: z.string().min(1).optional(),
  /**
   * The upstream's own input limits our catalog lets a run exceed: a JSONata condition read as a pricing formula reads
   * the run (top-level fields under the upstream's names, the prompt under `prompt_field`, `get_duration`; values, and the
   * sub-fields of list items, as our catalog spells them), and the limit as the upstream states it.
   */
  rejects: z.array(rejectSchema).optional(),
  pricing: pricingRule,
});

const llmRouteSchema = z.strictObject({ prefix: z.string(), upstreams: z.array(weighted) });

const llmPriceSchema = z.strictObject({
  input_cache_miss_per_mtok: z.number().min(0),
  input_cache_hit_per_mtok: z.number().min(0).optional(),
  input_cache_write_5m_per_mtok: z.number().min(0).optional(),
  input_cache_write_1h_per_mtok: z.number().min(0).optional(),
  output_per_mtok: z.number().min(0),
});

/** One token price a call is charged at, in USD per million tokens. */
export type LlmPrice = z.infer<typeof llmPriceSchema>;

/** A time of day in UTC, "HH:MM". */
const utcTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/**
 * A vendor's repeating discount on a direct price: every per-million-token price times `factor` outside its peak hours.
 * Peak is a UTC weekday in one window's `days` (0 = Sunday, as `Date.getUTCDay`), at a UTC time in `[from, to)`, on a
 * UTC date not in `holidays`.
 */
const offPeakSchema = z.strictObject({
  factor: z.number().gt(0).max(1),
  peak_utc: z.array(
    z.strictObject({ days: z.array(z.number().int().min(0).max(6)).min(1), from: utcTime, to: utcTime })
      // Only a window whose times are well formed is compared, so a malformed time is one problem.
      .refine((w) => w.from < w.to, { message: "an off-peak window's from is not before its to", when: (payload) => payload.issues.length === 0 }),
  ).min(1),
  holidays: z.array(z.iso.date()).default([]),
});

/** One direct price, as a model's first price states it: in effect from the start, with any off-peak discount. */
const directPriceSchema = llmPriceSchema.extend({ off_peak: offPeakSchema.optional() });

/** Gemini's inline request limit by default: the video-understanding page's 20 MB, the stricter of its two docs. */
const GEMINI_INLINE_MAX_BYTES = 20_000_000;

/**
 * OpenRouter's quantization levels, the only values its `provider.quantizations` takes (an unknown level answers 400
 * `expected one of "int4"|...|"unknown"`, measured 2026-11-07).
 */
const openRouterQuantization = z.enum(["int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"]);
/**
 * The levels of 8 bits and more, and `unknown`: 4- and 6-bit endpoints serve a coarser model. OpenRouter defines `unknown`
 * only as "Unknown", so a model takes it only when none of its endpoints states a level (`openRouterLevels`), as a
 * closed-weight model's own and its cloud partners' endpoints state none.
 */
const OPENROUTER_QUANTIZATIONS: readonly z.infer<typeof openRouterQuantization>[] = ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"];

/**
 * The quantizations a cheapest OpenRouter call of one model takes: `openrouter_quantizations`, without `unknown` when one of
 * the model's endpoints states a level, since an endpoint that states none could then be a coarser host's.
 * @param quantizations - `openrouter_quantizations`.
 * @param statesQuantization - Whether one of the model's OpenRouter endpoints states a level (`states_quantization`).
 * @returns The levels the model's call takes.
 */
export function openRouterLevels<T extends string>(quantizations: T[], statesQuantization: boolean): T[] {
  return statesQuantization ? quantizations.filter((q) => q !== "unknown") : quantizations;
}

/**
 * One OpenRouter token price, its cheapest endpoint's at the model's levels, with `states_quantization` when one of the
 * model's endpoints states a level, so its calls leave `unknown` out (`openRouterLevels`).
 */
const openRouterPriceSchema = llmPriceSchema.extend({ states_quantization: z.literal(true).optional() });

/** How often an uploaded Gemini file is asked about by default, in ms. */
const GEMINI_FILE_POLL_MS = 5_000;

const llmSchema = z.strictObject({
  routes: z.array(llmRouteSchema),
  understand_routes: z.array(llmRouteSchema).optional(),
  vendor_ids: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  openrouter_backends: z.record(z.string(), z.strictObject({ only: z.array(z.string()), allow_fallbacks: z.boolean() })).optional(),
  /**
   * Direct token prices in USD per million tokens, by our model id: a list whose first price has no `from`, so a listed
   * model always has a price in effect, and each later one takes effect at its `from` (an ISO 8601 UTC time, strictly
   * ascending), so a price the vendor has announced is in place before its day.
   */
  prices: z.record(
    z.string(),
    z.tuple([directPriceSchema], directPriceSchema.extend({ from: z.iso.datetime() }))
      .refine(([, ...later]) => later.every((entry, i) => i === 0 || Date.parse(entry.from) > Date.parse(later[i - 1]!.from)), { message: "the from dates of its direct prices do not ascend", when: (payload) => payload.issues.length === 0 }),
  ).optional(),
  /**
   * OpenRouter's token prices in USD per million tokens, by our model id, as `pnpm provider:prices` writes them: its
   * cheapest endpoint at a quantization `openrouter_quantizations` lists, `unknown` taken only when none of the model's
   * endpoints states a level; `states_quantization` marks a model one of whose endpoints does.
   */
  openrouter_prices: z.record(z.string(), openRouterPriceSchema).optional(),
  /**
   * When `openrouter_prices` was read, an ISO 8601 UTC time `pnpm provider:prices` writes: a direct price that took effect
   * after it is not ranked against them.
   */
  openrouter_prices_at: z.iso.datetime().optional(),
  /** The quantizations a cheapest call takes on OpenRouter (its `provider.quantizations`). */
  openrouter_quantizations: z.array(openRouterQuantization).min(1).default([...OPENROUTER_QUANTIZATIONS]),
  /** The request size past which Gemini takes media through its Files API, in bytes. */
  gemini_inline_max_bytes: z.number().int().positive().default(GEMINI_INLINE_MAX_BYTES),
  /** How often an uploaded Gemini file's state is asked about, in ms. */
  gemini_file_poll_ms: z.number().int().positive().default(GEMINI_FILE_POLL_MS),
});

const routingSchema = z.strictObject({
  models: z.record(z.string(), z.strictObject({ weights })).optional(),
  /** By prefix of `llm.routes`. */
  llm: z.record(z.string(), z.strictObject({ weights })).optional(),
  /** By prefix of `llm.understand_routes`. */
  understand: z.record(z.string(), z.strictObject({ weights })).optional(),
});

const inputSchema = z.strictObject({
  upstreams: z.record(z.string(), upstreamSchema),
  media: z.strictObject({
    models: z.record(z.string(), z.strictObject({
      /** The model vendor's own input limits, in our param names, each with the vendor page that states it; no upstream takes a run past them. */
      rejects: z.array(vendorRejectSchema).optional(),
      upstreams: z.array(bindingSchema),
    })),
  }),
  /** `config/provider/llm.yaml`. */
  llm: llmSchema.optional(),
  /** `config/provider/routing.yaml`; absent when the deployment ships none. */
  routing: routingSchema.optional(),
});

/** One upstream as `config/provider/upstreams.yaml` declares it. */
export type UpstreamDecl = z.infer<typeof upstreamSchema>;
/** How one of our params is written for one upstream. */
export type ParamBinding = z.infer<typeof paramSchema>;
/** One model bound to one upstream. */
export type MediaBinding = z.infer<typeof bindingSchema>;
/** The raw provider configuration, as read from the yaml files by the caller. */
export type ProviderConfigInput = z.input<typeof inputSchema>;
/** One LLM route: the first whose prefix matches a model id wins. */
export type LlmRoute = z.infer<typeof llmRouteSchema>;

/** The validated configuration, with deployment overrides applied. */
export interface ProviderConfig {
  upstreams: Record<string, UpstreamDecl>;
  models: Record<string, MediaBinding[]>;
  /** The model vendor's input limits, by model; a model without any is absent. */
  rejects: Record<string, Reject[]>;
  /** The LLM routing file, every field filled but `openrouter_prices_at`, which a file that never synced lacks. */
  llm: Required<Omit<z.infer<typeof llmSchema>, "openrouter_prices_at">> & Pick<z.infer<typeof llmSchema>, "openrouter_prices_at">;
}

/** The catalog facts a binding is checked against: each model's params and the values each offers. */
export interface CatalogShape {
  /** Each param's offered values, and the pool param a slot joins, when it joins one. */
  models: {
    name: string;
    params: Record<string, {
      values?: (string | number | boolean)[];
      joins?: string;
      /** `items` for a list of items, whose sub-fields are `fields`. */
      type?: string;
      fields?: Record<string, unknown>;
      /** `voices` for a param whose values are the catalog's voices. */
      remote_source?: string;
    }>;
  }[];
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
 * Report weights used twice, an upstream bound twice and upstreams upstreams.yaml does not declare.
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
  const bound = new Set<string>();
  for (const { upstream } of list) {
    if (bound.has(upstream)) problems.push(`${owner}: upstream "${upstream}" is bound more than once`);
    bound.add(upstream);
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
 * Whether one upstream field path writes into another: the same path, or one nested under the other.
 * @param a - A dotted path.
 * @param b - Another.
 * @returns True when they overlap.
 */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * The problems with what one binding writes: a fixed field another entry also writes, a pricing formula or a
 * `rejects` condition reading a dotted field, and a condition that is not JSONata.
 * @param model - The model.
 * @param binding - Its binding.
 * @returns The problem lines.
 */
function bindingFieldProblems(model: string, binding: MediaBinding): string[] {
  const problems: string[] = [];
  const written = [...Object.values(binding.params ?? {}).map((p) => p.field), ...(binding.prompt_field === undefined ? [] : [binding.prompt_field])];
  for (const fixed of Object.keys(binding.fixed ?? {})) {
    for (const field of written) {
      if (overlaps(fixed, field)) problems.push(`${model}: the binding to "${binding.upstream}" fixes "${fixed}", which "${field}" also writes`);
    }
  }
  const formulas = [binding.pricing, ...(binding.extra_steps ?? []).map((s) => s.pricing)].flatMap((rule) => {
    const read = pricingRuleSchema.safeParse(rule);
    return read.success ? [read.data.formula] : [];
  });
  for (const field of written.filter((f) => f.includes("."))) {
    if (formulas.some((f) => f.includes(field))) problems.push(`${model}: the binding to "${binding.upstream}" prices on "${field}", a dotted field pricing does not read`);
  }
  for (const { when } of binding.rejects ?? []) {
    const problem = formulaProblem(when);
    if (problem !== undefined) problems.push(`${model}: the binding to "${binding.upstream}" rejects when "${when}", which is not JSONata: ${problem}`);
    const dotted = written.find((f) => f.includes(".") && when.includes(f));
    if (dotted !== undefined) problems.push(`${model}: the binding to "${binding.upstream}" rejects when "${when}", which reads "${dotted}", a dotted field conditions do not read`);
  }
  return problems;
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
  for (const [name, decl] of Object.entries(raw.upstreams)) {
    if (decl.kind === "fal" && decl.billing_url === undefined) problems.push(`upstream "${name}": a fal upstream needs billing_url, the platform API its costs are read from`);
  }
  const models: Record<string, MediaBinding[]> = {};
  const rejects: Record<string, Reject[]> = {};
  for (const [model, { rejects: vendor, upstreams }] of Object.entries(raw.media.models)) {
    for (const { when } of vendor ?? []) {
      const problem = formulaProblem(when);
      if (problem !== undefined) problems.push(`${model}: the vendor's limit "${when}" is not JSONata: ${problem}`);
    }
    if (vendor !== undefined && vendor.length > 0) rejects[model] = vendor.map(({ source: _source, ...limit }) => limit);
    const bindings = overridden(model, upstreams, raw.routing?.models?.[model]?.weights, problems);
    checkList(model, bindings, raw.upstreams, problems);
    const sentByWaveSpeed = new Set(bindings.filter((b) => raw.upstreams[b.upstream]?.kind === "wavespeed").flatMap((b) => Object.keys(b.params ?? {})));
    for (const binding of bindings) {
      const { upstream } = binding;
      // An undeclared upstream is already reported by checkList.
      const kind = raw.upstreams[upstream]?.kind;
      const adapter = kind === undefined ? undefined : mediaAdapter(kind);
      if (kind !== undefined && adapter === undefined) problems.push(`${model}: upstream "${upstream}" is of kind "${kind}", which no media adapter speaks to`);
      if (adapter !== undefined) {
        for (const step of binding.extra_steps ?? []) {
          if (adapter.steps[step.kind] === undefined) problems.push(`${model}: the binding to "${upstream}" has an extra step of kind "${step.kind}", which the ${kind} adapter does not speak`);
          if (step.kind === "speak" && (binding.reused_by === undefined || step.at !== "after")) problems.push(`${model}: the binding to "${upstream}" has a speak step that does not follow its own voice call (it needs reused_by and at: after)`);
        }
      }
      if (kind === "fal" && binding.output_field === undefined) problems.push(`${model}: the binding to "${upstream}" has no output_field, which a fal binding needs`);
      if (kind !== undefined && kind !== "fal" && binding.output_field !== undefined) problems.push(`${model}: the binding to "${upstream}" has an output_field, which only a fal binding reads`);
      problems.push(...bindingFieldProblems(model, binding));
      if (kind !== "wavespeed") {
        for (const [param, drop] of Object.entries(binding.drops ?? {})) {
          if (drop === "*" && sentByWaveSpeed.has(param)) problems.push(`${model}: the binding to "${upstream}" drops "${param}" whatever its value, which the WaveSpeed binding sends`);
        }
      }
    }
    models[model] = [...bindings].sort((a, b) => a.weight - b.weight);
  }
  for (const name of Object.keys(raw.routing?.models ?? {})) {
    if (models[name] === undefined) problems.push(`${name}: the override names a model that has no bindings`);
  }
  /**
   * One LLM route with the deployment's weights, its problems reported.
   * @param route - The route.
   * @param label - What problems call it.
   * @param override - The deployment's weights for this route list, by prefix.
   * @returns The route with effective weights, lowest first.
   */
  const llmRoute = (route: LlmRoute, label: string, override: Record<string, { weights: Record<string, number> }> | undefined): LlmRoute => {
    const upstreams = overridden(label, route.upstreams, override?.[route.prefix]?.weights, problems);
    checkList(label, upstreams, raw.upstreams, problems);
    return { prefix: route.prefix, upstreams: [...upstreams].sort((a, b) => a.weight - b.weight) };
  };
  const llm: ProviderConfig["llm"] = {
    routes: (raw.llm?.routes ?? []).map((r) => llmRoute(r, `LLM route "${r.prefix}"`, raw.routing?.llm)),
    understand_routes: (raw.llm?.understand_routes ?? []).map((r) => llmRoute(r, `LLM understand route "${r.prefix}"`, raw.routing?.understand)),
    vendor_ids: raw.llm?.vendor_ids ?? {},
    openrouter_backends: raw.llm?.openrouter_backends ?? {},
    prices: raw.llm?.prices ?? {},
    openrouter_prices: raw.llm?.openrouter_prices ?? {},
    openrouter_prices_at: raw.llm?.openrouter_prices_at,
    openrouter_quantizations: raw.llm?.openrouter_quantizations ?? [...OPENROUTER_QUANTIZATIONS],
    gemini_inline_max_bytes: raw.llm?.gemini_inline_max_bytes ?? GEMINI_INLINE_MAX_BYTES,
    gemini_file_poll_ms: raw.llm?.gemini_file_poll_ms ?? GEMINI_FILE_POLL_MS,
  };
  /**
   * Report, for one list of LLM routes, an override naming a prefix no route has and an
   * upstream of a kind no adapter of that list speaks to.
   * @param routes - The routes, overrides applied.
   * @param override - The deployment's weights for the list, by prefix.
   * @param speaks - Whether an adapter of this list speaks to a kind.
   * @param list - What the list's routes are called: "route" or "understand route".
   * @param adapter - What its adapters are called: "LLM" or "understand".
   */
  const checkRoutes = (routes: LlmRoute[], override: Record<string, unknown> | undefined, speaks: (kind: string) => boolean, list: string, adapter: string): void => {
    for (const prefix of Object.keys(override ?? {})) {
      if (!routes.some((r) => r.prefix === prefix)) problems.push(`LLM ${list} "${prefix}": the override names a prefix no ${list} has`);
    }
    for (const route of routes) {
      for (const { upstream } of route.upstreams) {
        const kind = raw.upstreams[upstream]?.kind;
        if (kind !== undefined && !speaks(kind)) {
          problems.push(`LLM ${list} "${route.prefix}": upstream "${upstream}" is of kind "${kind}", which no ${adapter} adapter speaks to`);
        }
      }
    }
  };
  checkRoutes(llm.routes, raw.routing?.llm, hasLlmAdapter, "route", "LLM");
  checkRoutes(llm.understand_routes, raw.routing?.understand, hasUnderstandAdapter, "understand route", "understand");
  if (problems.length > 0) throw new ProviderConfigError(problems);
  return { upstreams: raw.upstreams, models, rejects, llm };
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
 * The values a drop serves a run at.
 * @param drop - One entry of a binding's `drops`, or none.
 * @returns Its listed values; undefined for a drop of every value (`"*"`, `{ all_values }`) and for no drop.
 */
export function droppedValues(drop: NonNullable<MediaBinding["drops"]>[string] | undefined): readonly (string | number | boolean)[] | undefined {
  if (Array.isArray(drop)) return drop;
  return typeof drop === "object" && "values" in drop ? drop.values : undefined;
}

/**
 * The problems with how one binding covers a model's params: each param bound or dropped exactly once, offered values only,
 * item sub-fields the catalog item has, and a voice map wherever a reseller takes our voices.
 * @param model - The model.
 * @param binding - One of its bindings.
 * @param params - The model's catalog params.
 * @param kind - The kind of the binding's upstream.
 * @returns The problem lines.
 */
function coverageProblems(model: string, binding: MediaBinding, params: CatalogShape["models"][number]["params"], kind: string | undefined): string[] {
  const problems: string[] = [];
  const at = `${model}: "${binding.upstream}"`;
  for (const param of Object.keys(binding.drops ?? {})) {
    if (params[param] === undefined) problems.push(`${at} drops param "${param}", which the model does not have`);
  }
  for (const [param, declared] of Object.entries(params)) {
    const bound = binding.params?.[param];
    const dropped = binding.drops?.[param];
    if (bound === undefined && dropped === undefined) problems.push(`${at} neither binds nor drops param "${param}"`);
    if (bound !== undefined && dropped !== undefined) problems.push(`${at} both binds and drops param "${param}"`);
    const offered = declared.values === undefined ? undefined : new Set(declared.values.map(String));
    for (const value of [...(bound?.supported ?? []), ...(droppedValues(dropped) ?? [])]) {
      // "" is a value that sends nothing, not one the param offers.
      if (offered !== undefined && value !== "" && !offered.has(String(value))) problems.push(`${at} lists value "${String(value)}" of "${param}", which the param does not offer`);
    }
    if (Array.isArray(dropped) && dropped.some((v) => v !== false && v !== "")) {
      problems.push(`${at} drops "${param}" for ${JSON.stringify(dropped)} without saying why its default gives those values; write { values, equivalent }`);
    }
    if (bound?.item_fields !== undefined) {
      if (declared.type !== "items") problems.push(`${at} gives item_fields to "${param}", which is not a list of items`);
      else {
        for (const sub of Object.keys(bound.item_fields)) {
          if (declared.fields?.[sub] === undefined) problems.push(`${at} maps sub-field "${sub}" of "${param}", which the catalog item does not have`);
        }
      }
    }
    if (declared.remote_source === "voices" && bound !== undefined && kind !== "wavespeed" && binding.voice_map?.[param] === undefined) {
      problems.push(`${at} takes voices in "${param}" without a voice_map`);
    }
  }
  return problems;
}

/**
 * Check every binding against our catalog.
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
    const pools = new Set(Object.values(params).flatMap((p) => (p.joins === undefined ? [] : [p.joins])));
    for (const binding of bindings) {
      problems.push(...coverageProblems(name, binding, params, config.upstreams[binding.upstream]?.kind));
      // A joined slot is named in the prompt by its pool's mention, so every binding writes one.
      for (const pool of pools) {
        if (binding.mentions?.[pool] === undefined) problems.push(`${name}: "${binding.upstream}" has no mentions template for "${pool}", which other params join`);
      }
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
