// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Micro-credits in one credit: the ledger's `numeric(20, 6)` scale. */
const MICRO_PER_CREDIT = 1_000_000;

/** Micro-credits in one hundredth of a credit, the smallest amount settled. */
const MICRO_PER_CENT = 10_000;

/**
 * A credit amount as it is settled: at most two decimals, any third raising
 * the second (inner#1666). The amount is first rounded to micro-credits, so
 * floating-point residue such as 7.000000000000001 settles as 7, not 7.01
 * (inner#1637). Charges, holds, estimates and displayed figures all go
 * through here, in the browser and on the server alike.
 * @param credits - A credit amount, zero or more.
 * @returns The amount rounded up to whole hundredths.
 * @throws {RangeError} When the amount is negative or not a finite number.
 */
export function ceilToCreditCent(credits: number): number {
  const micro = Math.round(credits * MICRO_PER_CREDIT);
  if (!Number.isFinite(micro) || micro < 0) {
    throw new RangeError(`ceilToCreditCent: not a credit amount (got ${credits})`);
  }
  return Math.ceil(Math.max(0, micro) / MICRO_PER_CENT) / 100;
}
