// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MembershipTier } from "@breatic/shared";
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
  const limits = effectiveTier === "enterprise" ? enterpriseState === "active" ? enterprise!.limits : null : getMembershipLimits(effectiveTier);
  return {
    asOf: clock.now.toISOString(),
    enterpriseState,
    effectiveTier,
    limits,
    storageBytes: effectiveTier === "enterprise" ? null : limits!.storage_bytes,
    revision: enterprise?.revision ?? null,
    expiresAt: enterprise?.expiresAt ?? null,
    fallbackTier: enterprise?.fallbackTier ?? null,
    settlementProtected,
  };
}
