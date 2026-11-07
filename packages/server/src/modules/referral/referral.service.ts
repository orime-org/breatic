// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { getMembershipReadingForUser, hasPaidMembership } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { getReferralConfig } from "@server/config/referral.js";
import { findBoundCode } from "@server/modules/referral/referral-binding.repo.js";
import { firstPeriodDiscountFor } from "@server/modules/referral/referral-discount.js";

/**
 * The first-period discount an account's next membership checkout carries.
 *
 * Read by the membership panel and by checkout, so both show the same answer.
 * @param userId - The account.
 * @param tx - The caller's transaction, if any.
 * @returns The bound code and the percent off, or null when there is no discount.
 * @throws {Error} if the account does not exist.
 */
export async function firstPeriodDiscount(
  userId: string,
  tx?: DbTx,
): Promise<{ code: string; percent: number } | null> {
  const code = await findBoundCode(userId, tx);
  if (code === null) return null;
  const percent = firstPeriodDiscountFor({
    bound: true,
    effectiveTier: (await getMembershipReadingForUser(userId, tx)).effectiveTier,
    paid: await hasPaidMembership(userId, tx),
    percent: getReferralConfig().first_period_discount_percent,
  });
  return percent === null ? null : { code, percent };
}
