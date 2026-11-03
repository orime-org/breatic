// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { evaluationMessage, holds, priceUsd, type PriceContract } from "@provider/pricing/evaluate.js";

/** How the caller wants its upstream chosen. */
export type Route =
  | { mode: "default" }
  | { mode: "upstream"; upstream: string }
  | { mode: "cheapest" };

/** One run as the application layer prepared it for an estimate. */
export interface EstimateInput {
  /** Our params after placeholders and joins. */
  params: Record<string, unknown>;
  prompt: string;
  /** Clip lengths of the sources whose every clip length is known, by our param name. */
  durations: Record<string, number[]>;
  /** The required sources not yet picked, each standing in as one placeholder. */
  placeholders: string[];
  /** The sources sent without every clip length known. */
  durationsMissing: string[];
}

/** How sure an estimate is. */
export type EstimateBound = "exact" | "at_least" | "at_most" | "per_thousand_chars";

/** What one upstream would charge for a run. */
export interface Estimate {
  usd: number;
  bound: EstimateBound;
  upstream: string;
}

/** Which of a model's upstreams this deployment can reach, in effective weight order. */
export interface Availability {
  upstreams: { upstream: string; weight: number; configured: boolean; envVar: string }[];
}

/** A model's pricing on each of its upstreams; opaque to the caller, sent to the browser with the model list. */
export interface PricingRules {
  readonly model: string;
  readonly upstreams: readonly unknown[];
}

/**
 * How one call on one upstream is priced: the upstream's published contract, WaveSpeed's
 * shape, `base_price` in millionths of a USD. The one definition the configuration load and
 * the browser both check against; an unknown key is refused.
 */
export const pricingRuleSchema = z.strictObject({
  kind: z.literal("formula"),
  base_price: z.number(),
  formula: z.string(),
  discount_rate: z.number(),
});

/** How one call on one upstream is priced. */
export type PricingRule = z.infer<typeof pricingRuleSchema>;

/**
 * One input limit of an upstream's own: a JSONata condition over the run, read exactly as a pricing formula reads it
 * (top-level fields under the upstream's names; values, and the sub-fields of list items, as our catalog spells them),
 * and the upstream's own words for the limit. A run it holds for cannot go there.
 */
export const rejectSchema = z.strictObject({ when: z.string().min(1), reason: z.string().min(1) });

/** Why an upstream cannot take a run: one of our param values it does not take, or one of its own limits. */
export type RejectedInput = { param: string; value: unknown } | { reason: string };

/**
 * What the browser needs to price a run on one upstream: the one description of the entry the
 * model list carries, checked whole wherever it is read back.
 */
const upstreamPricingSchema = z.looseObject({
  upstream: z.string(),
  /** The field the prompt is priced under; absent for a model that takes no prompt. */
  prompt_field: z.string().optional(),
  /** Our param name to the upstream's field, for the params whose names differ. */
  fields: z.record(z.string(), z.string()),
  pricing: pricingRuleSchema,
  /** Calls the run makes besides the model's own. */
  steps: z.array(z.looseObject({
    /** The param the step serves; the step is skipped when it carries nothing. */
    for_param: z.string().optional(),
    /** Whether the step runs once per item of its param. */
    per_item: z.boolean().optional(),
    /** Whether a cloned source lets a later run skip the step. */
    reused: z.boolean().optional(),
    pricing: pricingRuleSchema.optional(),
  })),
  /** The param whose source, once cloned, lets a later run skip the model's own call. */
  reused_by: z.string().optional(),
  /** Per param, the only values of ours this upstream takes; a run setting any other cannot go here. */
  limits: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))).optional(),
  /** Per param holding voices, the voices this upstream has. */
  voices: z.record(z.string(), z.array(z.string())).optional(),
  /** The upstream's own input limits, in order. */
  rejects: z.array(rejectSchema).optional(),
});

/** What the browser needs to price a run on one upstream. */
export type UpstreamPricing = z.infer<typeof upstreamPricingSchema>;

/** A model's pricing rules as the browser reads them back. */
const pricingRulesSchema = z.looseObject({ model: z.string(), upstreams: z.array(upstreamPricingSchema) });

const SAMPLE_TEXT = "x".repeat(1000);

/**
 * The evaluator's shape of a rule.
 * @param rule - The rule.
 * @returns The contract.
 */
function contractOf(rule: PricingRule): PriceContract {
  return { basePrice: rule.base_price, formula: rule.formula, discountRate: rule.discount_rate };
}

/**
 * Whether a value carries anything to send.
 * @param value - The value.
 * @returns False for null, undefined, an empty string or an empty list.
 */
export function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Whether any formula calls `fn` on this field.
 * @param formulas - The formulas.
 * @param fn - `get_duration` or `$length`.
 * @param field - The upstream field.
 * @returns True when some formula does.
 */
function billsBy(formulas: readonly string[], fn: string, field: string): boolean {
  const call = new RegExp(`${fn.replace("$", "\\$")}\\(\\s*${field}\\b`);
  return formulas.some((f) => call.test(f));
}

/**
 * Whether any formula names this field.
 * @param formulas - The formulas.
 * @param field - The upstream field.
 * @returns True when some formula does.
 */
function reads(formulas: readonly string[], field: string): boolean {
  const name = new RegExp(`\\b${field}\\b`);
  return formulas.some((f) => name.test(f));
}

/**
 * How an upstream names our params.
 * @param rule - The upstream's pricing entry.
 * @returns The upstream field of one of our params.
 */
function fieldNamer(rule: UpstreamPricing): (param: string) => string {
  return (param) => rule.fields[param] ?? param;
}

/**
 * A run in an upstream's field names, as its formulas and conditions read it: the params it is sent (a param
 * left out or empty is not) under its fields and clip lengths under the same fields; the prompt is the caller's to place.
 * @param rule - The upstream's pricing entry.
 * @param input - The prepared run.
 * @returns The fields and the clip lengths.
 */
function upstreamRun(rule: UpstreamPricing, input: EstimateInput): { fields: Record<string, unknown>; durations: Record<string, readonly number[]> } {
  const fieldOf = fieldNamer(rule);
  const fields: Record<string, unknown> = {};
  for (const [param, value] of Object.entries(input.params)) if (isPresent(value)) fields[fieldOf(param)] = value;
  const durations: Record<string, readonly number[]> = {};
  for (const [param, clips] of Object.entries(input.durations)) durations[fieldOf(param)] = clips;
  return { fields, durations };
}

/**
 * What one upstream would charge for a run, and how sure that is.
 * @param rule - The upstream's pricing.
 * @param input - The prepared run.
 * @returns The estimate.
 * @throws {Error} When a formula does not produce a finite price.
 */
async function estimateOn(rule: UpstreamPricing, input: EstimateInput): Promise<Estimate> {
  const fieldOf = fieldNamer(rule);
  const formulas = [rule.pricing.formula, ...rule.steps.map((s) => s.pricing?.formula ?? "")];
  const { fields, durations } = upstreamRun(rule, input);
  let unknown = input.placeholders.some((p) => reads(formulas, fieldOf(p)))
    || input.durationsMissing.some((p) => billsBy(formulas, "get_duration", fieldOf(p)));
  const promptField = rule.prompt_field;
  const textPriced = promptField !== undefined && input.prompt === "" && billsBy(formulas, "$length", promptField);
  const ownReused = rule.reused_by !== undefined && isPresent(input.params[rule.reused_by]);
  const stepReused = rule.steps.some((s) => s.reused === true && (s.for_param === undefined || isPresent(input.params[s.for_param])));

  /**
   * The run's price with the prompt field set to one value.
   * @param prompt - What the prompt field carries.
   * @param skippable - Whether to count the calls a reused source skips.
   * @returns USD.
   */
  const priceAt = async (prompt: string, skippable: boolean): Promise<number> => {
    if (promptField !== undefined) fields[promptField] = prompt;
    let usd = skippable || !ownReused ? await priceUsd(contractOf(rule.pricing), fields, durations) : 0;
    for (const step of rule.steps) {
      if (!skippable && step.reused === true) continue;
      const source = step.for_param === undefined ? undefined : input.params[step.for_param];
      if (step.for_param !== undefined && !isPresent(source)) continue;
      if (step.pricing === undefined) continue;
      const calls = step.per_item === true && Array.isArray(source) ? source.length : 1;
      usd += calls * (await priceUsd(contractOf(step.pricing), fields, durations));
    }
    return usd;
  };

  const usd = await priceAt(input.prompt, true);
  const everyRun = await priceAt(input.prompt, false);
  if (textPriced) {
    if (everyRun === 0) return { usd: await priceAt(SAMPLE_TEXT, false), bound: "per_thousand_chars", upstream: rule.upstream };
    unknown = true;
  }
  if (unknown) return { usd: everyRun, bound: "at_least", upstream: rule.upstream };
  return { usd, bound: ownReused || stepReused ? "at_most" : "exact", upstream: rule.upstream };
}

/**
 * The rules of each upstream, by name.
 * @param rules - A model's pricing rules.
 * @param upstream - The upstream.
 * @returns Its rule, if the model is priced there.
 */
function ruleOf(rules: PricingRules, upstream: string): UpstreamPricing | undefined {
  return (rules.upstreams as readonly UpstreamPricing[]).find((u) => u.upstream === upstream);
}

/**
 * Check pricing rules that came over the wire.
 * @param raw - What the model list carried.
 * @returns The rules.
 * @throws {Error} When they are not pricing rules.
 */
export function parsePricingRules(raw: unknown): PricingRules {
  const parsed = pricingRulesSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Not a model's pricing rules: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return { model: parsed.data.model, upstreams: parsed.data.upstreams };
}

/**
 * Why an upstream cannot take a run: a value outside its limits, a voice it does not have, or the first of its
 * own conditions (`rejects`) that holds. A param the run leaves out or empty is always taken, and is not there
 * for a condition to read; neither is an empty prompt. A condition that fails to evaluate on this run keeps
 * this upstream out, its reason followed by the evaluation error, and leaves every other upstream to its own rules.
 * @param rules - The model's pricing rules, whose entries carry each upstream's input limits.
 * @param upstream - The upstream.
 * @param input - The prepared run.
 * @returns The param and value it cannot take, or the reason of its condition; undefined when it takes the run or has no entry.
 */
export async function rejectedInput(rules: PricingRules, upstream: string, input: EstimateInput): Promise<RejectedInput | undefined> {
  const rule = ruleOf(rules, upstream);
  if (rule === undefined) return undefined;
  const allowed = [...Object.entries(rule.limits ?? {}), ...Object.entries(rule.voices ?? {})];
  for (const [param, values] of allowed) {
    const value = input.params[param];
    if (!isPresent(value)) continue;
    if (!values.some((v) => String(v) === String(value))) return { param, value };
  }
  if (rule.rejects === undefined) return undefined;
  const { fields, durations } = upstreamRun(rule, input);
  if (rule.prompt_field !== undefined && input.prompt !== "") fields[rule.prompt_field] = input.prompt;
  for (const { when, reason } of rule.rejects) {
    try {
      if (await holds(when, fields, durations)) return { reason };
    } catch (error) {
      return { reason: `${reason} (the condition could not be evaluated: ${evaluationMessage(error)})` };
    }
  }
  return undefined;
}

/**
 * Every configured upstream's estimate for a run, cheapest first and equal prices by weight.
 * @param rules - The model's pricing rules.
 * @param availability - Which upstreams are configured.
 * @param input - The prepared run.
 * @returns One estimate per configured upstream that can take the run.
 * @throws {Error} When a formula does not produce a finite price.
 */
export async function orderByPrice(rules: PricingRules, availability: Availability, input: EstimateInput): Promise<(Estimate & { weight: number })[]> {
  const out: (Estimate & { weight: number })[] = [];
  for (const { upstream, weight, configured } of availability.upstreams) {
    const rule = ruleOf(rules, upstream);
    if (!configured || rule === undefined || (await rejectedInput(rules, upstream, input)) !== undefined) continue;
    out.push({ ...(await estimateOn(rule, input)), weight });
  }
  return out.sort((a, b) => a.usd - b.usd || a.weight - b.weight);
}

/**
 * The estimate of the upstream the route would choose.
 * @param rules - The model's pricing rules.
 * @param availability - Which upstreams are configured.
 * @param input - The prepared run.
 * @param route - The caller's mode.
 * @returns The estimate, or null when the route reaches no configured upstream that can take the run.
 * @throws {Error} When a formula does not produce a finite price.
 */
export async function estimateCost(rules: PricingRules, availability: Availability, input: EstimateInput, route: Route): Promise<Estimate | null> {
  if (route.mode === "cheapest") {
    const [head] = await orderByPrice(rules, availability, input);
    return head === undefined ? null : { usd: head.usd, bound: head.bound, upstream: head.upstream };
  }
  const configured = [...availability.upstreams].sort((a, b) => a.weight - b.weight).filter((u) => u.configured);
  const pool = route.mode === "upstream" ? configured.filter((u) => u.upstream === route.upstream) : configured;
  for (const { upstream } of pool) {
    const rule = ruleOf(rules, upstream);
    if (rule !== undefined && (await rejectedInput(rules, upstream, input)) === undefined) return estimateOn(rule, input);
  }
  return null;
}
