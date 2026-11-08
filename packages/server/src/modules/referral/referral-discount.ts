// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether an account's next membership checkout gets the first-period discount.
 *
 * Only accounts that carry a code, are not on an enterprise membership and
 * have never paid for a membership qualify. The code's own status does not
 * matter: disabling or removing it never takes the discount from accounts
 * already bound to it.
 * @param input - What decides it.
 * @param input.bound - The account carries a referral code.
 * @param input.effectiveTier - The tier in force from the membership reading.
 * @param input.paid - Any subscription of the account reached its first activation.
 * @param input.percent - The configured discount.
 * @returns The percent off, or null when there is no discount.
 */
export function firstPeriodDiscountFor(input: {
  bound: boolean;
  effectiveTier: string;
  paid: boolean;
  percent: number;
}): number | null {
  return input.bound && input.effectiveTier !== "enterprise" && !input.paid ? input.percent : null;
}
