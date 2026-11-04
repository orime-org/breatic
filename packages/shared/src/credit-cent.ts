// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ceilCreditMicroToCent, quantizeQuotedCredits } from "@shared/credit-amount.js";

/**
 * A credit amount as it is settled: at most two decimals, any third raising
 * the second (inner#1666). The amount is first rounded to micro-credits, so
 * floating-point residue such as 7.000000000000001 settles as 7, not 7.01
 * (inner#1637). This number-valued adapter delegates quote quantization and
 * whole-cent rounding to the shared exact credit primitives.
 * @param credits - A credit amount, zero or more.
 * @returns The amount rounded up to whole hundredths.
 * @throws {RangeError} When the amount is negative or not a finite number.
 */
export function ceilToCreditCent(credits: number): number {
  return Number(ceilCreditMicroToCent(quantizeQuotedCredits(credits))) / 1_000_000;
}
