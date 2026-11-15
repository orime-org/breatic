// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a paid call is in credits (#296). provider answers what a model call cost; one credit is one US cent.
 */

/** Where a recorded cost came from. */
/** `computed` is a cost we price ourselves from a measured usage, such as a container run's seconds. */
export type CostSource = "provider" | "price_table" | "generation_lookup" | "computed" | "missing";

/**
 * Credits for a dollar amount: one credit per cent, times the multiplier.
 * @param costUsd - What the call cost, in US dollars.
 * @param multiplier - `CREDIT_MULTIPLIER`.
 * @returns Credits.
 */
export function creditsForUsd(costUsd: number, multiplier: number): number {
  return costUsd * 100 * multiplier;
}
