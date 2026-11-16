// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { MembershipTier } from "@breatic/shared";
import { MISSING_AGREEMENT_OPERATIONS, negotiatedOperationsOf } from "@core/auth/enterprise-membership-contract.js";
import type { EnterpriseRecord, EnterpriseMembershipProfile } from "@core/auth/enterprise-membership-contract.js";
import { periodContaining, type OperationPeriod } from "@core/auth/operation-period.js";
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
  // An active agreement's limits, completed with the two operation terms a
  // result stored before they existed lacks; an enterprise account without
  // one has no limits, and its storage stays uncapped (inner#1968).
  const limits = effectiveTier === "enterprise"
    ? enterpriseState === "active"
      ? {
        ...enterprise!.limits,
        monthly_operations: enterprise!.limits.monthly_operations ?? MISSING_AGREEMENT_OPERATIONS.monthlyOperations,
        running_tasks_per_user: enterprise!.limits.running_tasks_per_user ?? MISSING_AGREEMENT_OPERATIONS.runningTasksPerUser,
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

/** The facts a membership reading was taken from, beyond the reading itself. */
export interface OperationAllowanceFacts {
  /** When the account registered: the anchor of every tier without its own. */
  readonly userCreatedAt: Date;
  /** Its negotiated record, if any. */
  readonly enterprise: EnterpriseRecord | null;
  /** The subscription facts from the same statement. */
  readonly subscriptions: readonly SubscriptionRecord[];
  /** The instant of the reading. */
  readonly clock: SituationClock;
  /** Whether this deployment takes payments. */
  readonly paymentEnabled: boolean;
}

/** An account's monthly operations at the instant of one reading (inner#1968). */
export interface OperationAllowance {
  /** Operations included each month. */
  readonly monthly: number;
  /** What the monthly periods count from. */
  readonly anchor: Date;
  /** The period containing the reading's instant. */
  readonly period: OperationPeriod;
  /** Whether operations are counted and overage charged: payments on and a tier other than self_hosted. */
  readonly charging: boolean;
}

/**
 * The monthly operations of one membership reading (design 3.5).
 *
 * The anchor follows the effective tier: a paid tier governed by a
 * subscription of the same tier with a Stripe anchor counts from that anchor;
 * an active enterprise from its agreement's first save; every other case from
 * registration. The allowance is read from the same reading, so a changed
 * tier config takes effect on the next reading.
 * @param reading - One membership reading.
 * @param facts - The facts it was taken from.
 * @returns The allowance, its anchor and the current period.
 */
export function operationAllowanceOf(reading: EnterpriseMembershipProfile["reading"], facts: OperationAllowanceFacts): OperationAllowance {
  let anchor = facts.userCreatedAt;
  if (reading.effectiveTier === "enterprise" && reading.enterpriseState === "active" && facts.enterprise !== null) {
    anchor = new Date(facts.enterprise.createdAt);
  } else if (reading.effectiveTier === "pro" || reading.effectiveTier === "team") {
    const governing = subscriptionSituation(facts.subscriptions, facts.clock).record;
    if (governing?.tier === reading.effectiveTier && governing.billingCycleAnchor) anchor = governing.billingCycleAnchor;
  }
  return {
    monthly: negotiatedOperationsOf(reading).monthlyOperations,
    anchor,
    period: periodContaining(anchor, facts.clock.now),
    charging: facts.paymentEnabled && reading.effectiveTier !== "self_hosted",
  };
}
