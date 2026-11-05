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
  /** Source url to the sha256 key of the asset behind it; read with `clones`. */
  sourceKeys?: Readonly<Record<string, string>>;
  /**
   * The caller's live clones on every upstream, the whole truth when present: a reused call an upstream holds is left
   * out, one it does not hold is priced. Absent when the caller does not know them (the browser): a reused call is then
   * priced and the estimate is an upper bound.
   */
  clones?: readonly HeldClone[];
}

/** What a clone is of. */
export type CloneKind = "voice" | "vocal" | "element";

/** One live clone the caller holds; other fields, such as the upstream's id for it, may come along. */
export interface HeldClone {
  upstream: string;
  kind: CloneKind;
  /** The source asset's sha256, with a suffix for an element. */
  sourceKey: string;
}

/**
 * The cache key of the clone one call makes: a voice or vocal clone is keyed by the sha256 of the source its param
 * carries, an element by the sha256 of its item and its place in the list (`{sha}:Element {n}`, `n` from 1).
 * @param kind - The call's kind (`voice` for a binding's own call when it has `reused_by`).
 * @param param - The param the call reads its source from (`reused_by` for a voice, the step's `for_param` otherwise).
 * @param params - Our params.
 * @param sourceKeys - Source url to the sha256 key of the asset behind it.
 * @param itemIndex - For an element, its place in the list.
 * @returns The kind and key, or undefined for a call that makes no clone or a source without a key.
 */
export function cloneKeyOf(
  kind: string,
  param: string | undefined,
  params: Readonly<Record<string, unknown>>,
  sourceKeys: Readonly<Record<string, string>>,
  itemIndex: number | null,
): { kind: CloneKind; sourceKey: string } | undefined {
  if (param === undefined) return undefined;
  const value = params[param];
  if (kind === "voice" || kind === "vocal") {
    const sha = typeof value === "string" ? sourceKeys[value] : undefined;
    return sha === undefined ? undefined : { kind, sourceKey: sha };
  }
  if (kind === "element") {
    const index = itemIndex ?? 0;
    const item: unknown = Array.isArray(value) ? value[index] : undefined;
    const sha = typeof item === "string" ? sourceKeys[item] : undefined;
    return sha === undefined ? undefined : { kind, sourceKey: `${sha}:Element ${index + 1}` };
  }
  return undefined;
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

/**
 * Why an upstream cannot take a run: one of our param values it does not take, one of its own limits, or a
 * check that could not be made on this run (one of its limits, or its price, failed to evaluate), with the
 * evaluator's message.
 */
export type RejectedInput =
  | { param: string; value: unknown }
  | { reason: string; /** The evaluator's message, when the check could not be made. */ evaluationError?: string };

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
    /** What the step does; a clone's kind keys the clone it makes. */
    kind: z.string(),
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
  /** Per param, how the upstream names its references in the prompt (`{n}` from 1, `{i}` from 0). */
  mentions: z.record(z.string(), z.string()).optional(),
});

/** What the browser needs to price a run on one upstream. */
export type UpstreamPricing = z.infer<typeof upstreamPricingSchema>;

/** A model's pricing rules as the browser reads them back. */
const pricingRulesSchema = z.looseObject({ model: z.string(), upstreams: z.array(upstreamPricingSchema) });

const SAMPLE_TEXT = "x".repeat(1000);

/** A neutral reference the application writes into a prompt: `<<ref:{param}:{n}>>`. */
const REFERENCE = /<<ref:([\w-]+):(\d+)>>/g;

/**
 * The prompt with each neutral reference written the way an upstream names it; a reference to a param it has no template for stays as it is.
 * @param mentions - The upstream's template per param.
 * @param prompt - Our prompt.
 * @returns The prompt the upstream is sent.
 */
export function mentionsWritten(mentions: Readonly<Record<string, string>> | undefined, prompt: string): string {
  return prompt.replace(REFERENCE, (token, param: string, n: string) => {
    const template = mentions?.[param];
    return template === undefined ? token : template.replaceAll("{n}", n).replaceAll("{i}", String(Number(n) - 1));
  });
}

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
 * What one upstream would charge for a run, and how sure that is; the prompt is priced as it is sent.
 * @param rule - The upstream's pricing.
 * @param input - The prepared run.
 * @param run - The run in the upstream's field names (`upstreamRun`); its prompt field is set here.
 * @param run.fields - The fields.
 * @param run.durations - The clip lengths.
 * @returns The estimate.
 * @throws {jsonata.JsonataError} When a formula is not valid JSONata or fails to evaluate (a plain object, not an Error instance).
 * @throws {Error} When a formula gives no finite total_price for this run.
 */
async function estimateOn(rule: UpstreamPricing, input: EstimateInput, { fields, durations }: ReturnType<typeof upstreamRun>): Promise<Estimate> {
  const fieldOf = fieldNamer(rule);
  const formulas = [rule.pricing.formula, ...rule.steps.map((s) => s.pricing?.formula ?? "")];
  let unknown = input.placeholders.some((p) => reads(formulas, fieldOf(p)))
    || input.durationsMissing.some((p) => billsBy(formulas, "get_duration", fieldOf(p)));
  const promptField = rule.prompt_field;
  const textPriced = promptField !== undefined && input.prompt === "" && billsBy(formulas, "$length", promptField);
  const ownReused = rule.reused_by !== undefined && isPresent(input.params[rule.reused_by]);
  const stepReused = rule.steps.some((s) => s.reused === true && (s.for_param === undefined || isPresent(input.params[s.for_param])));
  const { clones } = input;

  /**
   * Whether this upstream holds the clone a call makes, by the caller's live clones.
   * @param kind - The call's kind.
   * @param param - The param it reads its source from.
   * @param itemIndex - For an element, its place in the list.
   * @returns False when the caller does not know its clones.
   */
  const held = (kind: string, param: string | undefined, itemIndex: number | null): boolean => {
    const key = clones === undefined ? undefined : cloneKeyOf(kind, param, input.params, input.sourceKeys ?? {}, itemIndex);
    return key !== undefined && clones!.some((c) => c.upstream === rule.upstream && c.kind === key.kind && c.sourceKey === key.sourceKey);
  };

  /**
   * The run's price with the prompt field set to one value. A reused call this upstream holds is left out; one the
   * caller does not know about is counted for the upper bound and left out of the price every run pays.
   * @param prompt - What the prompt field carries.
   * @param everyRun - Whether to leave out every reused call the caller does not know is made.
   * @returns USD.
   */
  const priceAt = async (prompt: string, everyRun: boolean): Promise<number> => {
    if (promptField !== undefined) fields[promptField] = mentionsWritten(rule.mentions, prompt);
    /**
     * Whether one call is left out.
     * @param reused - Whether a held clone lets the run skip it.
     * @param kind - The call's kind.
     * @param param - The param it reads its source from.
     * @param itemIndex - For an element, its place in the list.
     * @returns True when it is.
     */
    const skipped = (reused: boolean, kind: string, param: string | undefined, itemIndex: number | null): boolean =>
      reused && ((everyRun && clones === undefined) || held(kind, param, itemIndex));
    let usd = skipped(ownReused, "voice", rule.reused_by, null) ? 0 : await priceUsd(contractOf(rule.pricing), fields, durations);
    for (const step of rule.steps) {
      const source = step.for_param === undefined ? undefined : input.params[step.for_param];
      if (step.for_param !== undefined && !isPresent(source)) continue;
      if (step.pricing === undefined) continue;
      const items = step.per_item === true && Array.isArray(source) ? source.map((_, i) => i) : [null];
      const calls = items.filter((i) => !skipped(step.reused === true, step.kind, step.for_param, i)).length;
      if (calls > 0) usd += calls * (await priceUsd(contractOf(step.pricing), fields, durations));
    }
    return usd;
  };

  const usd = await priceAt(input.prompt, false);
  const everyRun = await priceAt(input.prompt, true);
  if (textPriced) {
    if (everyRun === 0) return { usd: await priceAt(SAMPLE_TEXT, true), bound: "per_thousand_chars", upstream: rule.upstream };
    unknown = true;
  }
  if (unknown) return { usd: everyRun, bound: "at_least", upstream: rule.upstream };
  // Only a caller that does not know its clones leaves a reused call in doubt.
  return { usd, bound: clones === undefined && (ownReused || stepReused) ? "at_most" : "exact", upstream: rule.upstream };
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
 * Whether one upstream takes a run, and its estimate when it does. An upstream whose price for the run cannot be
 * computed (a formula that fails to evaluate or gives no finite price) cannot take it, so routing and every
 * estimate leave it out alike.
 * @param rule - The upstream's pricing entry.
 * @param input - The prepared run.
 * @returns Why it cannot take the run, or what it would charge.
 */
async function assessed(rule: UpstreamPricing, input: EstimateInput): Promise<{ rejected: RejectedInput } | { estimate: Estimate }> {
  const allowed = [...Object.entries(rule.limits ?? {}), ...Object.entries(rule.voices ?? {})];
  for (const [param, values] of allowed) {
    const value = input.params[param];
    if (!isPresent(value)) continue;
    if (!values.some((v) => String(v) === String(value))) return { rejected: { param, value } };
  }
  const run = upstreamRun(rule, input);
  const { fields, durations } = run;
  if (rule.prompt_field !== undefined && input.prompt !== "") fields[rule.prompt_field] = mentionsWritten(rule.mentions, input.prompt);
  for (const { when, reason } of rule.rejects ?? []) {
    try {
      if (await holds(when, fields, durations)) return { rejected: { reason } };
    } catch (error) {
      return { rejected: { reason, evaluationError: evaluationMessage(error) } };
    }
  }
  try {
    return { estimate: await estimateOn(rule, input, run) };
  } catch (error) {
    return { rejected: { reason: `${rule.upstream}'s price for this run could not be computed`, evaluationError: evaluationMessage(error) } };
  }
}

/**
 * The rejection half of `assess`, for tests and the body script.
 * @param rules - The model's pricing rules.
 * @param upstream - The upstream.
 * @param input - The prepared run.
 * @returns What `assess` rejects the run for; undefined when it takes the run or has no entry.
 */
export async function rejectedInput(rules: PricingRules, upstream: string, input: EstimateInput): Promise<RejectedInput | undefined> {
  const read = await assess(rules, upstream, input);
  return read !== undefined && "rejected" in read ? read.rejected : undefined;
}

/**
 * One upstream's whole answer on a run, worked out once: why it cannot take the run, or what it would charge (as each
 * estimate reads it). It cannot take the run for a value outside its limits, a voice it does not have, the first of
 * its own conditions (`rejects`) that holds, or a check that cannot be made on this run (one of those conditions fails
 * to evaluate, or its price cannot be computed), which keeps this upstream out with the evaluator's message and leaves
 * every other upstream to its own rules. A param the run leaves out or empty is always taken, and is not there for a
 * condition to read; neither is an empty prompt. The prompt is read as the upstream is sent it, each reference written its way.
 * @param rules - The model's pricing rules, whose entries carry each upstream's input limits.
 * @param upstream - The upstream.
 * @param input - The prepared run, with the caller's live clones when it knows them.
 * @returns The param and value it cannot take, the reason of its condition, or the reason and the evaluation error; or
 *   the estimate; undefined when the rules list no such upstream.
 */
export async function assess(rules: PricingRules, upstream: string, input: EstimateInput): Promise<{ rejected: RejectedInput } | { estimate: Estimate } | undefined> {
  const rule = ruleOf(rules, upstream);
  return rule === undefined ? undefined : assessed(rule, input);
}

/**
 * The order of two priced upstreams: an estimate with a known price before one that is only a lower bound (a source
 * whose length is not known is priced at none), then the cheaper, then the lower weight.
 * @param a - One upstream's price.
 * @param a.usd - Its estimate.
 * @param a.atLeast - Whether the estimate is only a lower bound.
 * @param a.weight - Its weight.
 * @param b - The other.
 * @param b.usd - Its estimate.
 * @param b.atLeast - Whether the estimate is only a lower bound.
 * @param b.weight - Its weight.
 * @returns Negative when `a` goes first.
 */
export function byPrice(a: { usd: number; atLeast: boolean; weight: number }, b: { usd: number; atLeast: boolean; weight: number }): number {
  return Number(a.atLeast) - Number(b.atLeast) || a.usd - b.usd || a.weight - b.weight;
}

/**
 * Every configured upstream's estimate for a run, cheapest first and equal prices by weight; an estimate that is
 * only a lower bound (`at_least`) after every one with a known price.
 * @param rules - The model's pricing rules.
 * @param availability - Which upstreams are configured.
 * @param input - The prepared run.
 * @returns One estimate per configured upstream that can take the run and price it.
 */
export async function orderByPrice(rules: PricingRules, availability: Availability, input: EstimateInput): Promise<(Estimate & { weight: number })[]> {
  const out: (Estimate & { weight: number })[] = [];
  for (const { upstream, weight, configured } of availability.upstreams) {
    if (!configured) continue;
    const read = await assess(rules, upstream, input);
    if (read !== undefined && "estimate" in read) out.push({ ...read.estimate, weight });
  }
  return out.sort((a, b) => byPrice({ ...a, atLeast: a.bound === "at_least" }, { ...b, atLeast: b.bound === "at_least" }));
}

/**
 * The estimate of the upstream the route would choose.
 * @param rules - The model's pricing rules.
 * @param availability - Which upstreams are configured.
 * @param input - The prepared run.
 * @param route - The caller's mode.
 * @returns The estimate, or null when the route reaches no configured upstream that can take the run and price it.
 */
export async function estimateCost(rules: PricingRules, availability: Availability, input: EstimateInput, route: Route): Promise<Estimate | null> {
  if (route.mode === "cheapest") {
    const [head] = await orderByPrice(rules, availability, input);
    return head === undefined ? null : { usd: head.usd, bound: head.bound, upstream: head.upstream };
  }
  const configured = [...availability.upstreams].sort((a, b) => a.weight - b.weight).filter((u) => u.configured);
  const pool = route.mode === "upstream" ? configured.filter((u) => u.upstream === route.upstream) : configured;
  for (const { upstream } of pool) {
    const read = await assess(rules, upstream, input);
    if (read !== undefined && "estimate" in read) return read.estimate;
  }
  return null;
}
