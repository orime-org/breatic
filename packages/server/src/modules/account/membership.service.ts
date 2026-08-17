// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Everything the membership panel shows, in one read (task #90).
 *
 * The panel has a single request behind it, so this assembles the whole
 * answer: which tier the account is on, what that tier grants, how much of
 * the two account-level allowances it has spent, and the tiers it can
 * compare itself against.
 *
 * It lives in a service rather than in the route because assembling that
 * answer is domain work — deciding which tiers are comparable, deciding what
 * an enterprise account gets instead of ceilings — and routes here translate
 * protocol only (prohibition #1). The subscription work that comes later
 * needs the same "what is this account on, and what does it grant" read, and
 * a function is something it can call.
 */

import {
  getUserMembershipTier,
  getLimitsForUser,
  getMembershipLimits,
} from "@breatic/core";
import {
  COMPARABLE_MEMBERSHIP_TIERS,
  type AccountMembership,
} from "@breatic/shared";

import * as assetUsageService from "@server/modules/asset/assetUsage.service.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";

/**
 * Reads everything the membership panel needs for one account.
 * @param userId - The account to describe.
 * @returns Its tier, that tier's ceilings, its usage, and the comparable tiers.
 * @throws {Error} if the account does not exist, or if a usage query fails.
 */
export async function readAccountMembership(
  userId: string,
): Promise<AccountMembership> {
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
    })),
  };
}
