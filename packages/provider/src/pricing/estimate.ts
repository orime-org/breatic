// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** How the caller wants its upstream chosen (design 3.2). */
export type Route =
  | { mode: "default" }
  | { mode: "upstream"; upstream: string }
  | { mode: "cheapest" };

/** One run as the application layer prepared it for an estimate (design 7.2). */
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
  costUsd: number;
  bound: EstimateBound;
  upstream: string;
}

/** Which of a model's upstreams this deployment can reach, in effective weight order (design 3.3). */
export interface Availability {
  upstreams: { upstream: string; weight: number; configured: boolean; envVar: string }[];
}

/** A model's pricing on each of its upstreams; opaque to the caller, sent to the browser with the model list. */
export interface PricingRules {
  readonly model: string;
  readonly upstreams: readonly unknown[];
}

/**
 * Check pricing rules that came over the wire.
 * @param raw - What the model list carried.
 * @returns The rules.
 * @throws {Error} When they are not pricing rules.
 */
export function parsePricingRules(raw: unknown): PricingRules {
  void raw;
  throw new Error("parsePricingRules is not implemented");
}

/**
 * Every configured upstream's estimate for a run, cheapest first and equal prices by weight.
 * @param rules - The model's pricing rules.
 * @param availability - Which upstreams are configured.
 * @param input - The prepared run.
 * @returns One estimate per configured upstream.
 */
export async function orderByPrice(rules: PricingRules, availability: Availability, input: EstimateInput): Promise<(Estimate & { weight: number })[]> {
  void rules; void availability; void input;
  throw new Error("orderByPrice is not implemented");
}

/**
 * The estimate of the upstream the route would choose.
 * @param rules - The model's pricing rules.
 * @param availability - Which upstreams are configured.
 * @param input - The prepared run.
 * @param route - The caller's mode.
 * @returns The estimate, or null when the route reaches no configured upstream.
 */
export async function estimateCost(rules: PricingRules, availability: Availability, input: EstimateInput, route: Route): Promise<Estimate | null> {
  void rules; void availability; void input; void route;
  throw new Error("estimateCost is not implemented");
}
