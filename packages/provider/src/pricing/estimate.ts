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
  /**
   * The caller's clones, the whole truth when present: a clone call an upstream holds is left out, one it does not
   * hold is priced. Absent when the caller does not know them (the browser): a clone call is then priced and the
   * estimate is an upper bound.
   */
  known?: {
    /** Source url to the sha256 key of the asset behind it. */
    sourceKeys: Readonly<Record<string, string>>;
    /** The caller's live clones on every upstream. */
    clones: readonly HeldClone[];
  };
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
 * The cache key of the clone one call makes, from the url that call reads (`stepSource`): a voice or vocal clone is
 * keyed by that url's sha256, an element by its sha256 and its place in the list (`{sha}:Element {n}`, `n` from 1).
 * @param kind - The call's kind (`voice` for a binding's own call when it has `reused_by`).
 * @param param - The param the call reads its source from (`reused_by` for a voice, the step's `for_param` otherwise).
 * @param params - Our params.
 * @param sourceKeys - Source url to the sha256 key of the asset behind it.
 * @param itemIndex - The call's item index (stepCalls); null for a call that runs once.
 * @returns The kind and key, or undefined for a call that makes no clone or a source without a key.
 */
export function cloneKeyOf(
  kind: string,
  param: string | undefined,
  params: Readonly<Record<string, unknown>>,
  sourceKeys: Readonly<Record<string, string>>,
  itemIndex: number | null,
): { kind: CloneKind; sourceKey: string } | undefined {
  if (param === undefined || !makesClone(kind)) return undefined;
  const url = stepSource(params, param, itemIndex);
  const sha = url === undefined ? undefined : sourceKeys[url];
  if (sha === undefined) return undefined;
  return { kind, sourceKey: kind === "element" ? `${sha}:Element ${(itemIndex ?? 0) + 1}` : sha };
}

/**
 * Whether a call of this kind makes a clone, so a clone the upstream holds lets a run skip it; a binding's own call
 * is one when it has `reused_by` (kind `voice`).
 * @param kind - The call's kind.
 * @returns True for a voice, vocal or element clone.
 */
function makesClone(kind: string): kind is CloneKind {
  return kind === "voice" || kind === "vocal" || kind === "element";
}

/**
 * The clone an upstream holds for a key, among the caller's live clones.
 * @param clones - The caller's live clones.
 * @param upstream - The upstream.
 * @param key - The clone's kind and key (`cloneKeyOf`); undefined for a call that makes none.
 * @returns The clone, or undefined when the upstream holds none for the key.
 */
export function heldClone<T extends HeldClone>(clones: readonly T[], upstream: string, key: { kind: CloneKind; sourceKey: string } | undefined): T | undefined {
  return key === undefined ? undefined : clones.find((c) => c.upstream === upstream && c.kind === key.kind && c.sourceKey === key.sourceKey);
}

/**
 * The calls one extra step makes on a run, by item index.
 * @param step - The step.
 * @param step.for_param - The param it serves.
 * @param step.per_item - Whether it runs once per item of that param.
 * @param params - Our params.
 * @returns None when its param carries nothing, each index for a per-item step over a list, else one call (`null`).
 */
export function stepCalls(step: { for_param?: string; per_item?: boolean }, params: Readonly<Record<string, unknown>>): (number | null)[] {
  if (step.for_param === undefined) return [null];
  const value = params[step.for_param];
  if (!isPresent(value)) return [];
  return step.per_item === true && Array.isArray(value) ? value.map((_, i) => i) : [null];
}

/**
 * The url one call of a step reads: its param's value, or that value's item at the call's index.
 * @param params - Our params.
 * @param param - The param the step serves.
 * @param itemIndex - The call's item index; null for a step that runs once.
 * @returns The url, or undefined when the param carries none there.
 */
export function stepSource(params: Readonly<Record<string, unknown>>, param: string | undefined, itemIndex: number | null): string | undefined {
  const value = params[param ?? ""];
  const url: unknown = itemIndex === null ? value : Array.isArray(value) ? value[itemIndex] : undefined;
  return typeof url === "string" && url !== "" ? url : undefined;
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
  /** The model vendor's own input limits, read in our param names, which no upstream takes a run past. */
  readonly rejects?: readonly Reject[];
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

/** One input limit: the condition a run breaks it on, and the words for it. */
export type Reject = z.infer<typeof rejectSchema>;

/**
 * One input limit of the model's vendor, as configured: a condition over our param names (the prompt as `prompt`) and
 * the vendor's words, with the page that states it.
 */
export const vendorRejectSchema = rejectSchema.extend({ source: z.url() });

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
const pricingRulesSchema = z.looseObject({ model: z.string(), rejects: z.array(rejectSchema).optional(), upstreams: z.array(upstreamPricingSchema) });

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
 * A run in some field names, as formulas and conditions read it: the params it is sent (a param left out or empty
 * is not) under their fields and clip lengths under the same fields; the prompt is the caller's to place.
 * @param input - The prepared run.
 * @param fieldOf - The field each of our params goes under (an upstream's `fieldNamer`); our own names when left out.
 * @returns The fields and the clip lengths.
 */
function runIn(input: EstimateInput, fieldOf: (param: string) => string = (param) => param): { fields: Record<string, unknown>; durations: Record<string, readonly number[]> } {
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
 * @param run - The run in the upstream's field names (`runIn`); its prompt field is set here.
 * @param run.fields - The fields.
 * @param run.durations - The clip lengths.
 * @returns The estimate.
 * @throws {jsonata.JsonataError} When a formula is not valid JSONata or fails to evaluate (a plain object, not an Error instance).
 * @throws {Error} When a formula gives no finite total_price for this run.
 */
async function estimateOn(rule: UpstreamPricing, input: EstimateInput, { fields, durations }: ReturnType<typeof runIn>): Promise<Estimate> {
  const fieldOf = fieldNamer(rule);
  const formulas = [rule.pricing.formula, ...rule.steps.map((s) => s.pricing?.formula ?? "")];
  let unknown = input.placeholders.some((p) => reads(formulas, fieldOf(p)))
    || input.durationsMissing.some((p) => billsBy(formulas, "get_duration", fieldOf(p)));
  const promptField = rule.prompt_field;
  const textPriced = promptField !== undefined && input.prompt === "" && billsBy(formulas, "$length", promptField);
  const ownClones = rule.reused_by !== undefined && isPresent(input.params[rule.reused_by]);
  const stepClones = rule.steps.some((s) => makesClone(s.kind) && stepCalls(s, input.params).length > 0);
  const { known } = input;

  /**
   * The run's price with the prompt field set to one value. A clone call this upstream holds is left out; one the
   * caller does not know about is counted for the upper bound and left out of the price every run pays.
   * @param prompt - What the prompt field carries.
   * @param everyRun - Whether to leave out every clone call the caller does not know is made.
   * @returns USD.
   */
  const priceAt = async (prompt: string, everyRun: boolean): Promise<number> => {
    if (promptField !== undefined) fields[promptField] = mentionsWritten(rule.mentions, prompt);
    /**
     * Whether one call is left out.
     * @param clone - Whether the call makes a clone, which a held one lets the run skip.
     * @param kind - The call's kind.
     * @param param - The param it reads its source from.
     * @param itemIndex - For an element, its place in the list.
     * @returns True when it is.
     */
    const skipped = (clone: boolean, kind: string, param: string | undefined, itemIndex: number | null): boolean =>
      clone && (known === undefined
        ? everyRun
        : heldClone(known.clones, rule.upstream, cloneKeyOf(kind, param, input.params, known.sourceKeys, itemIndex)) !== undefined);
    let usd = skipped(ownClones, "voice", rule.reused_by, null) ? 0 : await priceUsd(contractOf(rule.pricing), fields, durations);
    for (const step of rule.steps) {
      if (step.pricing === undefined) continue;
      const calls = stepCalls(step, input.params).filter((i) => !skipped(makesClone(step.kind), step.kind, step.for_param, i)).length;
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
  // Only a caller that does not know its clones leaves a clone call in doubt.
  return { usd, bound: known === undefined && (ownClones || stepClones) ? "at_most" : "exact", upstream: rule.upstream };
}

/**
 * The first of some conditions that holds on a run.
 * @param rejects - The conditions, in order.
 * @param read - The run in the names they read.
 * @returns Its reason, or its reason and the evaluator's message when it cannot be evaluated; undefined when none holds.
 */
async function firstHeld(rejects: readonly Reject[], read: ReturnType<typeof runIn>): Promise<RejectedInput | undefined> {
  for (const { when, reason } of rejects) {
    try {
      if (await holds(when, read.fields, read.durations)) return { reason };
    } catch (error) {
      return { reason, evaluationError: evaluationMessage(error) };
    }
  }
  return undefined;
}

/**
 * One upstream's rule among a model's.
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
  if (!parsed.success) throw new Error(`Not a model's pricing rules: ${z.prettifyError(parsed.error)}`);
  return { model: parsed.data.model, ...(parsed.data.rejects === undefined ? {} : { rejects: parsed.data.rejects }), upstreams: parsed.data.upstreams };
}

/**
 * Whether one upstream takes a run, and its estimate when it does. An upstream whose price for the run cannot be
 * computed (a formula that fails to evaluate or gives no finite price) cannot take it, so routing and every
 * estimate leave it out alike.
 * @param rule - The upstream's pricing entry.
 * @param input - The prepared run.
 * @param vendor - The model vendor's limits, read in our param names.
 * @returns Why it cannot take the run, or what it would charge.
 */
async function assessed(rule: UpstreamPricing, input: EstimateInput, vendor: readonly Reject[]): Promise<{ rejected: RejectedInput } | { estimate: Estimate }> {
  const allowed = [...Object.entries(rule.limits ?? {}), ...Object.entries(rule.voices ?? {})];
  for (const [param, values] of allowed) {
    const value = input.params[param];
    if (!isPresent(value)) continue;
    if (!values.some((v) => String(v) === String(value))) return { rejected: { param, value } };
  }
  const written = input.prompt === "" ? "" : mentionsWritten(rule.mentions, input.prompt);
  // The vendor's limits read our names, the upstream's own its fields; the vendor's are checked first.
  const ours = runIn(input);
  if (written !== "") ours.fields.prompt = written;
  const run = runIn(input, fieldNamer(rule));
  if (rule.prompt_field !== undefined && written !== "") run.fields[rule.prompt_field] = written;
  const hit = (await firstHeld(vendor, ours)) ?? (await firstHeld(rule.rejects ?? [], run));
  if (hit !== undefined) return { rejected: hit };
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
 * the model vendor's conditions (read in our param names) or of its own (`rejects`) that holds, or a check that cannot be made on this run (one of those conditions fails
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
  return rule === undefined ? undefined : assessed(rule, input, rules.rejects ?? []);
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
