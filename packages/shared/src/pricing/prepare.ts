// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One run prepared for an estimate, the same way on both sides: what a run means in our product, laid out in our
 * param names for provider, which prices it on each upstream (`@breatic/provider/pricing`); and that price in credits.
 */

import { isPresent } from "@shared/item-cap";
import { joinSlotFiles } from "@shared/join-slot-files";
import { ceilToCreditCent } from "@shared/credit-cent";

/** What preparing a run reads off one declared param. */
export interface PreparableParam {
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

/** What preparing a run reads off one catalog model. */
export interface PreparableModel {
  readonly takes_prompt: boolean;
  readonly params: Readonly<Record<string, PreparableParam>>;
}

/** One run as the user has set it up so far. */
export interface EstimateInput {
  /** Values keyed by the catalog's param names. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly prompt?: string;
  /** Clip lengths in seconds of the sources in each param, keyed like `params`. */
  readonly durations?: Readonly<Record<string, readonly number[]>>;
  /**
   * Params the caller fills from media it already holds, counted as sources
   * whatever fill the catalog declares them with (a mini-tool's source and
   * slots are `fill: tool`).
   */
  readonly sources?: readonly string[];
}

/** One run as provider prices it: provider's `EstimateInput`, which this shape is checked against where it is passed. */
export interface PreparedRun {
  /** Our params after placeholders and joins, every priced param present. */
  params: Record<string, unknown>;
  prompt: string;
  /** Clip lengths of the sources whose every clip length is known, by our param name. */
  durations: Record<string, number[]>;
  /** The required sources not yet picked, each standing in as one placeholder. */
  placeholders: string[];
  /** The sources sent without every clip length known. */
  durationsMissing: string[];
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

/** What a required source not picked yet stands for: the one item the run cannot go without. */
const UNPICKED = "unpicked";

const CENTS_PER_USD = 100;

/**
 * Prepare one run for an estimate. A required source not picked yet stands in as one placeholder, judged on the
 * user's own params (style files joining a pool do not fill the picture a run cannot go without); a joining slot's
 * files travel inside their pool and its note in the prompt; a prompt not written yet stays empty.
 * @param model - The model's catalog entry.
 * @param input - The run as set up so far, its params resolved.
 * @returns The run as provider prices it.
 */
export function prepareRunParams(model: PreparableModel, input: EstimateInput): PreparedRun {
  const priced = Object.entries(model.params).filter(([, spec]) => spec.joins === undefined);
  /**
   * A param's value in a record, else what the model declares it as.
   * @param record - The params to read.
   * @param name - The param's name.
   * @param spec - Its declaration.
   * @returns The value, its default, or an empty list for a list param.
   */
  const valueOf = (record: Readonly<Record<string, unknown>>, name: string, spec: PreparableParam): unknown =>
    record[name] ?? spec.default ?? (spec.type === "list" ? [] : undefined);
  /**
   * Whether a param carries media the run reads.
   * @param name - The param's name.
   * @param spec - Its declaration.
   * @returns True for a canvas or pool param, or one the caller named.
   */
  const isSource = (name: string, spec: PreparableParam): boolean =>
    spec.fill === "canvas" || spec.fill === "pool" || (input.sources?.includes(name) ?? false);

  const own: Record<string, unknown> = { ...input.params };
  const placeholders: string[] = [];
  for (const [name, spec] of priced) {
    if (isSource(name, spec) && !isPresent(valueOf(own, name, spec)) && spec.optional !== true) {
      own[name] = spec.type === "list" ? [UNPICKED] : UNPICKED;
      placeholders.push(name);
    }
  }

  const prompt = input.prompt ?? "";
  const joined = joinSlotFiles(model.params, own, prompt);
  const params: Record<string, unknown> = {};
  const durations: Record<string, number[]> = {};
  const durationsMissing: string[] = [];
  for (const [name, spec] of priced) {
    const value = valueOf(joined.params, name, spec);
    params[name] = value ?? null;
    if (isSource(name, spec) && isPresent(value)) {
      const known = input.durations?.[name] ?? [];
      if (known.length >= (Array.isArray(value) ? value.length : 1)) durations[name] = [...known];
      else durationsMissing.push(name);
    }
  }
  return { params, prompt: prompt === "" ? "" : joined.prompt, durations, placeholders, durationsMissing };
}

/**
 * An estimate in USD as credits: a credit per cent, times the multiplier, rounded up to the cent as the charge will be.
 * @param estimate - What provider estimated, or null when no upstream can serve the run.
 * @param estimate.usd - The price in USD.
 * @param estimate.bound - How it bounds the charge.
 * @param creditMultiplier - Credits per US cent charged upstream.
 * @returns The credits and their bound, or undefined without an estimate.
 */
export function creditEstimateOf(
  estimate: { usd: number; bound: EstimateBound } | null,
  creditMultiplier: number,
): CreditEstimate | undefined {
  if (estimate === null) return undefined;
  return { credits: ceilToCreditCent(estimate.usd * CENTS_PER_USD * creditMultiplier), bound: estimate.bound };
}
