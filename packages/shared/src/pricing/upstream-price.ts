// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import jsonata from "jsonata";

/**
 * One endpoint's pricing contract as WaveSpeed publishes it: `basePrice` in
 * millionths of a USD, a JSONata `formula` (empty means a flat `basePrice`
 * per call), and `discountRate` in percent.
 */
export interface UpstreamPricing {
  readonly basePrice: number;
  readonly formula: string;
  readonly discountRate: number;
}

/** Known clip lengths in seconds, keyed by the upstream field holding the clips. */
export type ClipDurations = Readonly<Record<string, readonly number[]>>;

const MICRO_USD_PER_USD = 1_000_000;

// WaveSpeed writes `get_duration(field)` and `get_duration(field, min=a,
// max=b, total=c)` without the `$` JSONata needs for a function, and the
// keyword form parses as comparisons. Both are rewritten to pass the field
// name, so the function looks the clips up instead of receiving their URLs.
const GET_DURATION =
  /get_duration\(\s*(\w+)\s*(?:,\s*min=([\d.]+)\s*,\s*max=([\d.]+)\s*,\s*total=([\d.]+)\s*)?\)/g;

/**
 * Rewrites WaveSpeed's `get_duration` calls into a registered JSONata function.
 * @param formula - The formula as published.
 * @returns The formula JSONata can compile.
 */
function rewriteGetDuration(formula: string): string {
  return formula.replace(
    GET_DURATION,
    (_all, field: string, min?: string, max?: string, total?: string) =>
      min === undefined ? `$get_duration("${field}")` : `$get_duration("${field}", ${min}, ${max}, ${total})`,
  );
}

/**
 * Billed seconds of one field's clips: each clip clamped to `[min, max]`,
 * then the sum capped at `total`. A field with no known clips bills zero.
 * @param clips - The field's clip lengths in seconds.
 * @param min - Lower bound per clip.
 * @param max - Upper bound per clip.
 * @param total - Upper bound on the sum.
 * @returns The seconds the endpoint bills for this field.
 */
function billedSeconds(clips: readonly number[], min?: number, max?: number, total?: number): number {
  const sum = clips.reduce((acc, clip) => acc + Math.min(max ?? Infinity, Math.max(min ?? 0, clip)), 0);
  return Math.min(total ?? Infinity, sum);
}

/**
 * Evaluates an endpoint's pricing contract for one request.
 * @param pricing - The endpoint's pricing contract.
 * @param input - The request in upstream field names; every field the formula reads must be present.
 * @param durations - Known clip lengths for the fields `get_duration` reads.
 * @returns The price in USD after the discount.
 * @throws {Error} When the formula does not produce a finite `total_price`.
 */
export async function upstreamPriceUsd(
  pricing: UpstreamPricing,
  input: Readonly<Record<string, unknown>>,
  durations: ClipDurations,
): Promise<number> {
  const discount = pricing.discountRate / 100;
  if (pricing.formula.trim() === "") return (pricing.basePrice / MICRO_USD_PER_USD) * discount;

  const expression = jsonata(rewriteGetDuration(pricing.formula));
  expression.registerFunction(
    "get_duration",
    (field: string, min?: number, max?: number, total?: number) =>
      billedSeconds(durations[field] ?? [], min, max, total),
    "<sn?n?n?:n>",
  );
  const result: unknown = await expression.evaluate({ ...input, base_price: pricing.basePrice });
  const total = (result as { total_price?: unknown } | undefined)?.total_price;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new Error(`Pricing formula produced no finite total_price: ${pricing.formula}`);
  }
  return (total / MICRO_USD_PER_USD) * discount;
}
