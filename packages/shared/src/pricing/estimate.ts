// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ExtraStep, PricingContract } from "@shared/types/model-catalog";
import { isPresent } from "@shared/item-cap";
import { joinSlotFiles } from "@shared/join-slot-files";
import { upstreamPriceUsd } from "@shared/pricing/upstream-price";

/** What the estimate reads off one declared param. */
export interface PricedParam {
  readonly upstream?: string;
  readonly default?: unknown;
  readonly fill?: string;
  readonly type?: string;
  readonly optional?: boolean;
  /** The pool a style slot's files travel in, for a model with no field for them. */
  readonly joins?: string;
  /** The sentence naming a joining slot's files in the prompt. */
  readonly prompt_note?: string;
  /** How a pool names its files in the prompt. */
  readonly mention?: string;
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
 * least that, while something the price reads is not known yet (a source's
 * length, a required source not picked, text not written) -- counting only
 * what every such run pays; at most that, when a call a reused source skips
 * is counted in; or that much per thousand characters, while the text is
 * empty and what every run pays follows the text alone.
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
 * go without, and a prompt not written yet as no text. Where a formula reads
 * what is not known yet the answer is a lower bound, without the calls a
 * reused source skips. While the text is empty and what every run pays
 * follows the text alone, the run is quoted per thousand characters instead.
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

  // A required source the reader has not filled stands in as one placeholder,
  // judged on the reader's own params: style files joining a pool do not fill
  // the picture a run cannot go without.
  const priced = Object.entries(model.params).filter(([, spec]) => spec.joins === undefined);
  /**
   * A param's value in a record, else what the model declares it as.
   * @param record - The params to read.
   * @param name - The param's name.
   * @param spec - Its declaration.
   * @returns The value, its default, or an empty list for a list param.
   */
  const valueOf = (record: Record<string, unknown>, name: string, spec: PricedParam): unknown =>
    record[name] ?? spec.default ?? (spec.type === "list" ? [] : undefined);
  const own: Record<string, unknown> = { ...input.params };
  let unknown = false;
  for (const [name, spec] of priced) {
    const source = spec.fill === "canvas" || spec.fill === "pool";
    if (source && !isPresent(valueOf(own, name, spec)) && spec.optional !== true) {
      own[name] = spec.type === "list" ? [UNPICKED] : UNPICKED;
      if (reads(formulas, spec.upstream ?? name)) unknown = true;
    }
  }

  // Priced as sent: a joining slot's files are counted inside their pool.
  const joined = joinSlotFiles(model.params, own, input.prompt ?? "");
  const params: Record<string, unknown> = { ...joined.params };
  const upstream: Record<string, unknown> = {};
  const durations: Record<string, readonly number[]> = {};
  for (const [name, spec] of priced) {
    const field = spec.upstream ?? name;
    const value = valueOf(joined.params, name, spec);
    const source = spec.fill === "canvas" || spec.fill === "pool";
    upstream[field] = value;
    if (source && isPresent(value)) {
      const known = input.durations?.[name] ?? [];
      if (known.length >= itemCount(value)) durations[field] = known;
      else if (billsBy(formulas, "get_duration", field)) unknown = true;
    }
  }

  // An empty prompt stays empty, so a model billed by prompt length can be
  // quoted per thousand characters below; a written one is priced as sent,
  // with any joining slot's note.
  const text = (input.prompt ?? "") === "" ? "" : joined.prompt;
  const textPriced = model.takes_prompt && text === "" && billsBy(formulas, "$length", promptField);

  // The model's own call is skipped when its source was used before, and so is
  // every step marked reused whose source is sent.
  const ownReused = model.reused_by !== undefined && isPresent(params[model.reused_by]);
  const stepReused = steps.some(
    (step) => step.reused === true && (step.for_param === undefined || isPresent(params[step.for_param])),
  );

  /**
   * The run's price in US dollars with the prompt field set to one value.
   * @param prompt - What the prompt field carries.
   * @param skippable - Whether to count the calls a reused source skips.
   * @returns The price, with every added upstream call counted.
   * @throws {Error} When a pricing formula does not produce a finite price.
   */
  const priceUsd = async (prompt: string, skippable: boolean): Promise<number> => {
    if (model.takes_prompt) upstream[promptField] = prompt;
    let usd = skippable || !ownReused ? await upstreamPriceUsd(toPricing(model.pricing), upstream, durations) : 0;
    for (const step of steps) {
      if (!skippable && step.reused === true) continue;
      const source = step.for_param === undefined ? undefined : params[step.for_param];
      if (step.for_param !== undefined && !isPresent(source)) continue;
      const calls = step.per_item ? itemCount(source) : 1;
      usd += calls * (await upstreamPriceUsd(toPricing(step.pricing), upstream, durations));
    }
    return usd;
  };

  /**
   * A price in US dollars, in credits.
   * @param amount - The price.
   * @returns The credits it comes to.
   */
  const toCredits = (amount: number): number => amount * CENTS_PER_USD * creditMultiplier;
  const usd = await priceUsd(text, true);
  // What every run of this setup pays: a lower bound counts only this.
  const everyRun = await priceUsd(text, false);
  if (textPriced) {
    // Quoted per thousand characters when that follows the text alone.
    if (everyRun === 0) {
      return { credits: toCredits(await priceUsd(SAMPLE_TEXT, false)), bound: "per_thousand_chars" };
    }
    unknown = true;
  }
  if (unknown) return { credits: toCredits(everyRun), bound: "at_least" };
  if (ownReused || stepReused) return { credits: toCredits(usd), bound: "at_most" };
  return { credits: toCredits(usd), bound: "exact" };
}

/**
 * Reads a yaml pricing contract into the evaluator's shape.
 * @param contract - The contract as the catalog writes it.
 * @returns The same contract for {@link upstreamPriceUsd}.
 */
function toPricing(contract: PricingContract): { basePrice: number; formula: string; discountRate: number } {
  return { basePrice: contract.base_price, formula: contract.formula, discountRate: contract.discount_rate };
}
