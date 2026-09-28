// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { upstreamPriceUsd } from "@shared/pricing/upstream-price";

/** An endpoint's WaveSpeed pricing contract, as the catalog yaml writes it. */
export interface PricingContract {
  readonly base_price: number;
  readonly formula: string;
  readonly discount_rate: number;
}

/** What the estimate reads off one declared param. */
export interface PricedParam {
  readonly upstream?: string;
  readonly default?: unknown;
  readonly fill?: string;
  readonly type?: string;
}

/** An upstream call a run makes besides the model's own. */
export interface PricedStep {
  readonly endpoint: string;
  readonly pricing: PricingContract;
  /** The param whose value makes the run take this step; absent means every run does. */
  readonly for_param?: string;
  /** One call per item of `for_param`. */
  readonly per_item?: boolean;
  /** Skipped when the same source was sent through it before. */
  readonly reused?: boolean;
}

/** What the estimate reads off one catalog model. */
export interface PricedModel {
  readonly takes_prompt: boolean;
  /** The upstream field the prompt is sent as, when it is not `prompt`. */
  readonly prompt_upstream?: string;
  readonly params: Readonly<Record<string, PricedParam>>;
  readonly pricing: PricingContract;
  /** The param whose source, once sent, lets later runs skip the model's own call. */
  readonly reused_by?: string;
  readonly extra_steps?: readonly PricedStep[];
}

/** One run as the reader has set it up so far. */
export interface EstimateInput {
  /** Values keyed by the catalog's param names. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly prompt?: string;
  /** Clip lengths in seconds of the sources in each param, keyed like `params`. */
  readonly durations?: Readonly<Record<string, readonly number[]>>;
}

/**
 * How the credits relate to what the run will be charged: exactly that; at
 * least that, while a source's length is unknown; at most that, when a step
 * a reused source skips is counted in; or that much per thousand characters,
 * while a model priced by its text has none.
 */
export type EstimateBound = "exact" | "at_least" | "at_most" | "per_thousand_chars";

/** An estimate of one run, in credits. */
export interface CreditEstimate {
  readonly credits: number;
  readonly bound: EstimateBound;
}

const CENTS_PER_USD = 100;
const SAMPLE_TEXT = "x".repeat(1000);

/**
 * Whether a param holds anything to send.
 * @param value - The param's value.
 * @returns False for nothing, an empty string and an empty list.
 */
function holds(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

/**
 * How many sources a param carries.
 * @param value - The param's value.
 * @returns The list length, or 1 for a single value.
 */
function itemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 1;
}

/**
 * Whether any of the formulas bills by a function of this upstream field.
 * @param formulas - The formulas the run is priced by.
 * @param fn - The function name, `get_duration` or `$length`.
 * @param field - The upstream field.
 * @returns True when some formula calls `fn` on the field.
 */
function billsBy(formulas: readonly string[], fn: string, field: string): boolean {
  const call = new RegExp(`${fn.replace("$", "\\$")}\\(\\s*${field}\\b`);
  return formulas.some((f) => call.test(f));
}

/**
 * Estimates one run of a model, in credits.
 * @param model - The model's catalog entry.
 * @param input - The run as set up so far.
 * @param creditMultiplier - Credits per US cent charged upstream.
 * @returns The credits and how they bound the charge.
 * @throws {Error} When a pricing formula does not produce a finite price.
 */
export async function estimateCredits(
  model: PricedModel,
  input: EstimateInput,
  creditMultiplier: number,
): Promise<CreditEstimate> {
  const steps = model.extra_steps ?? [];
  const formulas = [model.pricing.formula, ...steps.map((s) => s.pricing.formula)];
  const promptField = model.prompt_upstream ?? "prompt";

  const upstream: Record<string, unknown> = {};
  const durations: Record<string, readonly number[]> = {};
  let lengthUnknown = false;
  for (const [name, spec] of Object.entries(model.params)) {
    const field = spec.upstream ?? name;
    const value = input.params[name] ?? spec.default ?? (spec.type === "list" ? [] : undefined);
    upstream[field] = value;
    if ((spec.fill === "canvas" || spec.fill === "pool") && holds(value)) {
      const known = input.durations?.[name] ?? [];
      if (known.length >= itemCount(value)) durations[field] = known;
      else if (billsBy(formulas, "get_duration", field)) lengthUnknown = true;
    }
  }

  const text = input.prompt ?? "";
  const sampled = model.takes_prompt && text === "" && billsBy(formulas, "$length", promptField);
  if (model.takes_prompt) upstream[promptField] = sampled ? SAMPLE_TEXT : text;

  let usd = await upstreamPriceUsd(toPricing(model.pricing), upstream, durations);
  let reusedCounted = model.reused_by !== undefined && holds(input.params[model.reused_by]);
  for (const step of steps) {
    const source = step.for_param === undefined ? undefined : input.params[step.for_param];
    if (step.for_param !== undefined && !holds(source)) continue;
    const calls = step.per_item ? itemCount(source) : 1;
    usd += calls * (await upstreamPriceUsd(toPricing(step.pricing), upstream, durations));
    if (step.reused) reusedCounted = true;
  }

  const credits = usd * CENTS_PER_USD * creditMultiplier;
  if (sampled) return { credits, bound: "per_thousand_chars" };
  if (lengthUnknown) return { credits, bound: "at_least" };
  if (reusedCounted) return { credits, bound: "at_most" };
  return { credits, bound: "exact" };
}

/**
 * Reads a yaml pricing contract into the evaluator's shape.
 * @param contract - The contract as the catalog writes it.
 * @returns The same contract for {@link upstreamPriceUsd}.
 */
function toPricing(contract: PricingContract): { basePrice: number; formula: string; discountRate: number } {
  return { basePrice: contract.base_price, formula: contract.formula, discountRate: contract.discount_rate };
}
