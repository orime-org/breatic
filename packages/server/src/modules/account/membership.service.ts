// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Everything the membership panel shows, in one read (task #90).
 *
 * The panel has a single request behind it, so this assembles the whole
 * answer: which tier the account is on, what that tier grants, how much of
 * the two account-level allowances it has spent, the tiers it can compare
 * itself against with their prices, and what its subscription is doing.
 *
 * It lives in a service rather than in the route because assembling that
 * answer is domain work — deciding which tiers are comparable, deciding what
 * an enterprise account gets instead of ceilings — and routes here translate
 * protocol only (prohibition #1). The subscription reading (#106) needs the
 * same "what is this account on, and what does it grant" answer, so it is
 * assembled here too rather than in a second request.
 */

import {
  env,
  getUserMembershipTier,
  getLimitsForUser,
  getMembershipLimits,
  getSubscriptionPlan,
} from "@breatic/core";
import {
  COMPARABLE_MEMBERSHIP_TIERS,
  type AccountMembership,
  type ComparableMembershipTier,
} from "@breatic/shared";

import * as assetUsageService from "@server/modules/asset/assetUsage.service.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { readSubscriptionSummary } from "@server/modules/subscription/subscription-panel.js";

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
  // Whether this deployment sells anything is decided once, here, and shapes
  // two things at once: the prices on the comparison table and whether there
  // is a subscription to describe. A self-hosted install has neither.
  const selling = env.PAYMENT_ENABLED;

  // Reconciling comes FIRST, because it can correct the tier. Reading the
  // tier before it and reporting the correction afterwards would answer this
  // request with the value the correction just replaced — the one request
  // where being right matters most, since the reader opened the panel because
  // their allowances looked wrong. It would also hand the front end two
  // contradictory tiers in one response.
  const subscription = selling ? await readSubscriptionSummary(userId) : null;

  const tier = await getUserMembershipTier(userId);

  // Asked before the ceilings, because asking for an enterprise account's
  // ceilings throws by design. Going through `getLimitsForUser` first would
  // turn a legitimate account into a 500.
  const limits = tier === "enterprise" ? null : await getLimitsForUser(userId);

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
      ...priceOf(offered, selling),
    })),
    subscription,
  };
}

/**
 * What one tier costs, when this deployment sells it.
 * @param tier - The tier the row describes.
 * @param selling - Whether this deployment sells subscriptions.
 * @returns The price and its currency, both null when there is no price.
 */
function priceOf(
  tier: ComparableMembershipTier,
  selling: boolean,
): { priceCents: number | null; currency: string | null } {
  // `base` is free rather than cheap: it has no plan to quote, and quoting
  // zero would be a price nobody set.
  if (!selling || tier === "base") {
    return { priceCents: null, currency: null };
  }
  const plan = getSubscriptionPlan(tier);
  return { priceCents: plan.priceCents, currency: plan.currency };
}
