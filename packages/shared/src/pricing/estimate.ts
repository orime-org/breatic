// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ExtraStep, PricingContract } from "@shared/types/model-catalog";
import { upstreamPriceUsd } from "@shared/pricing/upstream-price";

/** What the estimate reads off one declared param. */
export interface PricedParam {
  readonly upstream?: string;
  readonly default?: unknown;
  readonly fill?: string;
  readonly type?: string;
  readonly optional?: boolean;
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
  readonly extra_steps?: readonly ExtraStep[];
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

/** What a required source not picked yet stands for: the one item the run cannot go without. */
const UNPICKED = "unpicked";

/**
 * Whether any of the formulas reads this upstream field at all.
 * @param formulas - The formulas the run is priced by.
 * @param field - The upstream field.
 * @returns True when some formula names the field.
 */
function reads(formulas: readonly string[], field: string): boolean {
  const name = new RegExp(`\\b${field}\\b`);
  return formulas.some((f) => name.test(f));
}

/**
 * Estimates one run of a model, in credits.
 *
 * A required source not picked yet is priced as the one item the run cannot
 * go without; a prompt not written yet is priced as no text. Either makes the
 * answer a lower bound. Only a model whose whole price follows its text is
 * quoted per thousand characters instead.
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

  const params: Record<string, unknown> = { ...input.params };
  const upstream: Record<string, unknown> = {};
  const durations: Record<string, readonly number[]> = {};
  let unknown = false;
  for (const [name, spec] of Object.entries(model.params)) {
    const field = spec.upstream ?? name;
    let value = input.params[name] ?? spec.default ?? (spec.type === "list" ? [] : undefined);
    const source = spec.fill === "canvas" || spec.fill === "pool";
    if (source && !holds(value) && spec.optional !== true) {
      value = spec.type === "list" ? [UNPICKED] : UNPICKED;
      params[name] = value;
      if (reads(formulas, field)) unknown = true;
    }
    upstream[field] = value;
    if (source && holds(value)) {
      const known = input.durations?.[name] ?? [];
      if (known.length >= itemCount(value)) durations[field] = known;
      else if (billsBy(formulas, "get_duration", field)) unknown = true;
    }
  }

  const text = input.prompt ?? "";
  const textPriced = model.takes_prompt && text === "" && billsBy(formulas, "$length", promptField);

  /**
   * The run's price in US dollars with the prompt field set to one value.
   * @param prompt - What the prompt field carries.
   * @returns The price, with every added upstream call counted.
   * @throws {Error} When a pricing formula does not produce a finite price.
   */
  const priceUsd = async (prompt: string): Promise<number> => {
    if (model.takes_prompt) upstream[promptField] = prompt;
    let usd = await upstreamPriceUsd(toPricing(model.pricing), upstream, durations);
    for (const step of steps) {
      const source = step.for_param === undefined ? undefined : params[step.for_param];
      if (step.for_param !== undefined && !holds(source)) continue;
      const calls = step.per_item ? itemCount(source) : 1;
      usd += calls * (await upstreamPriceUsd(toPricing(step.pricing), upstream, durations));
    }
    return usd;
  };

  const usd = await priceUsd(text);
  const toCredits = (amount: number): number => amount * CENTS_PER_USD * creditMultiplier;
  if (textPriced) {
    if (usd === 0) return { credits: toCredits(await priceUsd(SAMPLE_TEXT)), bound: "per_thousand_chars" };
    unknown = true;
  }
  const reusedCounted =
    (model.reused_by !== undefined && holds(params[model.reused_by])) ||
    steps.some((step) => step.reused === true && (step.for_param === undefined || holds(params[step.for_param])));
  const credits = toCredits(usd);
  if (unknown) return { credits, bound: "at_least" };
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
