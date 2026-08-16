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
  type MembershipLimits,
} from "@breatic/core";
import type { MembershipTier } from "@breatic/shared";

import * as assetUsageService from "@server/modules/asset/assetUsage.service.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";

/**
 * The tiers a person can compare themselves against and move between.
 *
 * Not `CONFIGURED_MEMBERSHIP_TIERS`, which also carries `self_hosted` — that
 * one is a deployment shape rather than something anybody buys. `enterprise`
 * is absent for a different reason: its ceilings are negotiated per customer
 * and are not in the config file at all.
 */
const COMPARABLE_TIERS = ["base", "pro", "team"] as const;

/** One row of the comparison table. */
export interface TierOffer {
  /** Which tier this row describes. */
  readonly tier: (typeof COMPARABLE_TIERS)[number];
  /** That tier's six ceilings, read from `config/membership.yaml`. */
  readonly limits: MembershipLimits;
}

/** What one account has spent of the two allowances counted account-wide. */
export interface AccountUsage {
  /** How many team studios this account currently administers. */
  readonly teamStudios: number;
  /** Live bytes across the studios this account controls. */
  readonly storageBytes: number;
}

/** The whole answer behind the membership panel. */
export interface AccountMembership {
  /** The tier stored on this account. */
  readonly tier: MembershipTier;
  /**
   * That tier's six ceilings, or `null` for `enterprise`.
   *
   * `null` says "this tier's ceilings do not come from configuration", which
   * is a real state rather than a failure: they are agreed per customer, and
   * #105 made reading them throw so that nobody could quietly invent a set.
   * A read that genuinely fails still throws.
   */
  readonly limits: MembershipLimits | null;
  /** How much of the account-level allowances is spent. */
  readonly usage: AccountUsage;
  /** The tiers offered for comparison, in ascending order. */
  readonly catalog: readonly TierOffer[];
}

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
    catalog: COMPARABLE_TIERS.map((offered) => ({
      tier: offered,
      limits: getMembershipLimits(offered),
    })),
  };
}
