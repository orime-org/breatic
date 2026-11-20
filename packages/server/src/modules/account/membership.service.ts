// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Everything the membership panel shows, in one read (task #90).
 *
 * The panel has a single request behind it, so this assembles the whole
 * answer: which tier the account is on, what that tier grants, how much of
 * the two account-level allowances it has spent, the tiers it can compare
 * itself against with their prices, and what its subscription is doing.
 *
 * It lives in a service rather than in the route because assembling that
 * answer is domain work — deciding which tiers are comparable and what each
 * costs on this deployment — and routes here translate protocol only
 * (prohibition #1).
 *
 * The tier is read from our own data (#307), through the same period-end check
 * the ceilings use, so the panel never shows a tier the ceilings do not grant;
 * prices and the outstanding invoice come from the billing service (inner#1993
 * §3.2 #17).
 */

import { env, getCommerceConfig, getMembershipForUser, getMembershipLimits, logger, membershipPanelAnswerSchema } from "@breatic/core";
import {
  COMPARABLE_MEMBERSHIP_TIERS,
  type AccountMembership,
  type BillingPeriod,
  type ComparableMembershipTier,
  type TierPrice,
} from "@breatic/shared";

import * as assetUsageService from "@server/modules/asset/assetUsage.service.js";
import { requestCommerce, userPath } from "@server/modules/commerce/commerce-client.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { readStoredSubscriptionSummary } from "@server/modules/subscription/subscription-panel.js";

type Prices = Readonly<Record<string, Readonly<Record<BillingPeriod, TierPrice | null>>>>;

/** The last prices the billing service quoted, kept for a read that fails. */
let lastPrices: { prices: Prices; at: number } | null = null;

/**
 * Reads everything the membership panel needs for one account.
 * @param userId - The account to describe.
 * @returns Its tier, that tier's ceilings, its usage, the comparable tiers
 *   with their prices, and its subscription.
 * @throws {Error} if the account does not exist, or if a usage query fails.
 */
export async function readAccountMembership(
  userId: string,
): Promise<AccountMembership> {
  // Whether this deployment sells anything shapes two things at once: the
  // prices on the comparison table and whether there is a subscription to
  // describe. A self-hosted install has neither.
  const selling = env.SELLING;
  const [stored, quoted] = selling
    ? await Promise.all([readStoredSubscriptionSummary(userId), readBillingPanel(userId)])
    : [null, null];
  const subscription = stored === null ? null : { ...stored, payableInvoiceUrl: quoted?.payableInvoiceUrl ?? null };
  const { tier, limits } = await getMembershipForUser(userId);

  const [teamStudios, storageBytes] = await Promise.all([
    studioRepo.countTeamStudiosAdministeredBy(userId),
    assetUsageService.accountStorageUsage(userId),
  ]);

  return {
    tier,
    limits,
    usage: { teamStudios, storageBytes },
    catalog: COMPARABLE_MEMBERSHIP_TIERS.map((offered) => ({
      tier: offered,
      limits: getMembershipLimits(offered),
      prices: pricesOf(offered, quoted?.prices ?? null),
    })),
    subscription,
  };
}

/**
 * The panel's prices and outstanding invoice from the billing service. A
 * failed read falls back to the prices it last quoted, while they are younger
 * than `catalog_cache_seconds`, and to none after that.
 * @param userId - The account.
 * @returns The prices (null when none can be quoted) and the invoice page.
 */
async function readBillingPanel(userId: string): Promise<{ prices: Prices | null; payableInvoiceUrl: string | null }> {
  try {
    const answer = membershipPanelAnswerSchema.parse(
      await requestCommerce({ method: "GET", path: userPath(userId, "/membership-panel"), quick: true }),
    );
    lastPrices = { prices: answer.data.prices, at: Date.now() };
    return answer.data;
  } catch (err) {
    logger.error({ err, userId }, "commerce_panel_read_failed");
    const fresh = lastPrices !== null && Date.now() - lastPrices.at < getCommerceConfig().catalog_cache_seconds * 1000;
    return { prices: fresh ? lastPrices!.prices : null, payableInvoiceUrl: null };
  }
}

/**
 * What one tier costs over each billing period, as the billing service quotes it.
 * @param tier - The tier the row describes.
 * @param prices - The quoted prices, or null when none can be quoted.
 * @returns One entry per period, each null when there is no price to quote.
 */
function pricesOf(tier: ComparableMembershipTier, prices: Prices | null): Record<BillingPeriod, TierPrice | null> {
  // `base` is free rather than cheap: it has no plan to quote.
  return { month: null, year: null, ...(tier === "base" ? {} : prices?.[tier]) };
}
