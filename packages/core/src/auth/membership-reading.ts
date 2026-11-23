// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { MembershipTier } from "@breatic/shared";
import { runningTasksPerUserOf } from "@core/auth/enterprise-membership-contract.js";
import type { EnterpriseRecord, EnterpriseMembershipProfile } from "@core/auth/enterprise-membership-contract.js";
import { getMembershipLimits } from "@core/config/membership.js";
import { subscriptionSituation, tierForSituation } from "@core/auth/subscription-state.js";
import type { SituationClock, SubscriptionRecord } from "@core/auth/subscription-state.js";

/**
 * Resolve every entitlement and settlement decision from the same loaded facts.
 * @param storedTier - The account's stored tier.
 * @param enterprise - Its negotiated record, including historical records.
 * @param subscriptions - The subscription facts from the same SQL statement.
 * @param clock - One instant and the ordinary subscription grace period.
 * @returns Entitlements at that instant.
 * @throws {Error} When the configured tier limits cannot be read.
 */
export function resolveMembershipReading(
  storedTier: MembershipTier,
  enterprise: EnterpriseRecord | null,
  subscriptions: readonly SubscriptionRecord[],
  clock: SituationClock,
): EnterpriseMembershipProfile["reading"] {
  let enterpriseState: EnterpriseMembershipProfile["reading"]["enterpriseState"] = "ordinary";
  let effectiveTier = storedTier;
  let settlementProtected = storedTier === "self_hosted";
  if (storedTier === "enterprise") {
    enterpriseState = enterprise === null ? "missing" : clock.now.getTime() < Date.parse(enterprise.expiresAt) ? "active" : "expired";
    settlementProtected = enterpriseState !== "expired" || enterprise?.fallbackTier === "self_hosted";
    if (enterpriseState === "expired") {
      const ordinary = subscriptionSituation(subscriptions, clock);
      effectiveTier = enterprise?.fallbackTier === "self_hosted" ? "self_hosted" : tierForSituation(ordinary.situation, ordinary.record);
    }
  } else if (storedTier === "pro" || storedTier === "team") {
    const ordinary = subscriptionSituation(subscriptions, clock);
    if (ordinary.lapsed.length > 0) effectiveTier = tierForSituation(ordinary.situation, ordinary.record);
  }
  // An active agreement's limits. The record's schema also reads earlier
  // stored results, so its running-task term is optional in the type although
  // a live agreement row always holds one; runningTasksPerUserOf is the one
  // place that fills it. An enterprise account without an agreement has no
  // limits, and its storage stays uncapped (inner#1968).
  const limits = effectiveTier === "enterprise"
    ? enterpriseState === "active"
      ? {
        ...enterprise!.limits,
        running_tasks_per_user: runningTasksPerUserOf({ limits: enterprise!.limits }),
      }
      : null
    : getMembershipLimits(effectiveTier);
  return {
    asOf: clock.now.toISOString(),
    enterpriseState,
    effectiveTier,
    limits,
    storageBytes: limits === null ? null : limits.storage_bytes,
    revision: enterprise?.revision ?? null,
    expiresAt: enterprise?.expiresAt ?? null,
    fallbackTier: enterprise?.fallbackTier ?? null,
    settlementProtected,
  };
}
