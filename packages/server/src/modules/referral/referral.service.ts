// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { db, getMembershipReadingForUser, getStripeCallTimeoutMs, hasPaidMembership, logger } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { getReferralConfig } from "@server/config/referral.js";
import { getStripeClient } from "@server/infra/stripe.js";
import { getStripeCustomerId } from "@server/modules/auth/user.repo.js";
import { findLatestApplication } from "@server/modules/referral/promoter-application.repo.js";
import { bindReferral } from "@server/modules/referral/referral-binding.service.js";
import type { BindOutcome } from "@server/modules/referral/referral-binding.service.js";
import { findBoundCode } from "@server/modules/referral/referral-binding.repo.js";
import { findCodeOfPromoter } from "@server/modules/referral/referral-code.repo.js";
import type { ReferralCodeStatus } from "@server/modules/referral/referral-code.repo.js";
import { firstPeriodDiscountFor } from "@server/modules/referral/referral-discount.js";
import { frontendOrigin } from "@server/utils/frontend-origin.js";

/** What the membership panel's two referral sections read (inner#1868 §8). */
export interface AccountReferral {
  firstPeriodDiscountPercent: number;
  binding: { code: string; discountPending: boolean } | null;
  canBind: boolean;
  program: { open: boolean; termsVersion: string };
  promoter:
    | { state: "none" }
    | { state: "pending"; submittedAt: string }
    | { state: "rejected"; decidedAt: string; note: string | null }
    | { state: "approved"; code: string; link: string; codeStatus: ReferralCodeStatus };
}

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

/**
 * Reads what the account sees in the membership panel's referral sections.
 * @param userId - The signed-in account.
 * @param termsVersion - `promoter_terms_version` now; empty while applications are closed.
 * @returns The panel's view.
 * @throws {Error} if the account does not exist.
 */
export async function readAccountReferral(userId: string, termsVersion: string): Promise<AccountReferral> {
  const percent = getReferralConfig().first_period_discount_percent;
  const [bound, reading, paid, latest, own] = await Promise.all([
    findBoundCode(userId),
    getMembershipReadingForUser(userId),
    hasPaidMembership(userId),
    findLatestApplication(userId),
    findCodeOfPromoter(userId),
  ]);
  const enterprise = reading.effectiveTier === "enterprise";
  const discount = firstPeriodDiscountFor({ bound: bound !== null, effectiveTier: reading.effectiveTier, paid, percent });
  let promoter: AccountReferral["promoter"] = { state: "none" };
  if (own !== null) {
    promoter = { state: "approved", code: own.code, link: `${frontendOrigin()}/register?ref=${own.code}`, codeStatus: own.status };
  } else if (latest?.status === "pending") {
    promoter = { state: "pending", submittedAt: latest.createdAt.toISOString() };
  } else if (latest?.status === "rejected") {
    promoter = { state: "rejected", decidedAt: (latest.decidedAt ?? latest.createdAt).toISOString(), note: latest.applicantNote };
  }
  return {
    firstPeriodDiscountPercent: percent,
    binding: bound === null ? null : { code: bound, discountPending: discount !== null },
    canBind: bound === null && !enterprise && !paid,
    program: { open: termsVersion !== "", termsVersion },
    promoter,
  };
}

/**
 * Expires the account's open full-price membership checkouts, so none of them charges full price after a backfill.
 * @param userId - The account.
 * @returns Nothing; a failure is logged and the binding stands.
 */
async function expireOpenMembershipCheckouts(userId: string): Promise<void> {
  try {
    const customer = await getStripeCustomerId(userId);
    if (customer === null) return;
    const call = { timeout: getStripeCallTimeoutMs(), maxNetworkRetries: 0 };
    const stripe = getStripeClient();
    const open = await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 }, call);
    for (const session of open.data) {
      // A page with the coupon was made after the binding, so it already charges the discounted price.
      if (session.mode !== "subscription" || session.discounts?.length) continue;
      try {
        await stripe.checkout.sessions.expire(session.id, {}, call);
      } catch (err) {
        logger.error({ err, userId, sessionId: session.id }, "referral_backfill_checkout_expire_failed");
      }
    }
  } catch (err) {
    logger.error({ err, userId }, "referral_backfill_checkout_expire_failed");
  }
}

/**
 * Binds a code typed into the membership panel by an account that never paid.
 * @param userId - The signed-in account.
 * @param code - What was typed.
 * @returns Bound, or why not.
 * @throws {Error} if the database fails.
 */
export async function bindLater(userId: string, code: string): Promise<BindOutcome> {
  const outcome = await db.transaction((tx) => bindReferral({ userId, code, source: "later" }, tx));
  if (outcome.ok) await expireOpenMembershipCheckouts(userId);
  return outcome;
}
