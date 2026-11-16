// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The monthly operations allowance an account reads from one membership
 * reading (inner#1968, test spec area C: C-09 to C-15, C-17, C-18, and the
 * 5.1 #3 resolution).
 *
 * `operationAllowanceOf(reading, facts)` answers `{ monthly, anchor, period,
 * charging }`. The anchor follows the effective tier: a paid tier governed by
 * a subscription of the same tier with an anchor uses that anchor; any other
 * ordinary tier, and an expired enterprise that falls back to base, uses the
 * registration time; an active enterprise uses its agreement's first-save
 * time; an enterprise without an agreement uses the registration time and
 * 16,000 operations. `charging` is payments on and an effective tier other
 * than self_hosted.
 */

import { describe, expect, it } from "vitest";
import { resolveMembershipReading, operationAllowanceOf } from "../membership-reading.js";
import type { SubscriptionRecord } from "../subscription-state.js";
import type { EnterpriseRecord } from "../enterprise-membership-contract.js";
import type { MembershipTier } from "@breatic/shared";

const REGISTERED = new Date("2026-05-03T07:00:00.000Z");
const NOW = new Date("2026-11-15T12:00:00.000Z");
const SUB_ANCHOR = new Date("2026-11-10T00:00:00.000Z");

/**
 * One live subscription row, carrying the new anchor column.
 * @param tier - Its paid tier.
 * @param billingCycleAnchor - Stripe's anchor, or null for a row not yet re-observed.
 * @param period - How it is billed.
 * @returns The row.
 */
function subscription(tier: MembershipTier, billingCycleAnchor: Date | null, period: "month" | "year" = "month"): SubscriptionRecord {
  return {
    stripeSubscriptionId: `sub-${tier}-${period}`,
    tier,
    period,
    status: "active",
    cancelAtPeriodEnd: false,
    hasPendingUpdate: false,
    currentPeriodEnd: new Date("2027-12-10T00:00:00.000Z"),
    billingCycleAnchor,
  } as SubscriptionRecord;
}

/**
 * A negotiated enterprise record.
 * @param createdAt - When it was first saved.
 * @param expiresAt - Its exclusive deadline.
 * @param monthlyOperations - The agreed monthly operations.
 * @returns The record.
 */
function agreement(createdAt: string, expiresAt: string, monthlyOperations: number): EnterpriseRecord {
  return {
    expiresAt,
    entryTimezone: "UTC",
    contractNumber: "ENT-1968",
    fallbackTier: "base",
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    limits: {
      team_studios: 8,
      projects_per_studio: 20,
      concurrent_editors: 30,
      studio_members: 200,
      project_members: 80,
      storage_bytes: 1099511627776,
      monthly_operations: monthlyOperations,
      running_tasks_per_user: 10,
    },
  } as EnterpriseRecord;
}

interface Account {
  storedTier: MembershipTier;
  enterprise?: EnterpriseRecord | null;
  subscriptions?: readonly SubscriptionRecord[];
  registeredAt?: Date;
  now?: Date;
  paymentEnabled?: boolean;
}

/**
 * Read an account's allowance the way the repository does: one reading, then
 * the allowance from that same reading and the facts it was taken from.
 * @param account - The stored facts.
 * @returns The allowance.
 */
function allowance(account: Account): ReturnType<typeof operationAllowanceOf> {
  const clock = { now: account.now ?? NOW, staleAfterMs: 0 };
  const enterprise = account.enterprise ?? null;
  const subscriptions = account.subscriptions ?? [];
  const reading = resolveMembershipReading(account.storedTier, enterprise, subscriptions, clock);
  return operationAllowanceOf(reading, {
    userCreatedAt: account.registeredAt ?? REGISTERED,
    enterprise,
    subscriptions,
    clock,
    paymentEnabled: account.paymentEnabled ?? true,
  });
}

/**
 * The period as ISO strings.
 * @param period - A period.
 * @param period.start - Its start.
 * @param period.end - Its end.
 * @returns Both bounds as ISO strings.
 */
function isoPeriod(period: { start: Date; end: Date }): { start: string; end: string } {
  return { start: period.start.toISOString(), end: period.end.toISOString() };
}

describe("operationAllowanceOf", () => {
  it("C-10 a pro account governed by a pro subscription uses the subscription's anchor and 4000 operations", () => {
    const result = allowance({ storedTier: "pro", subscriptions: [subscription("pro", SUB_ANCHOR)] });
    expect(result.monthly).toBe(4000);
    expect(result.anchor.toISOString()).toBe(SUB_ANCHOR.toISOString());
    expect(result.charging).toBe(true);
    expect(isoPeriod(result.period)).toEqual({ start: "2026-11-10T00:00:00.000Z", end: "2026-12-10T00:00:00.000Z" });
  });

  it("C-09 a yearly subscription's anchor still yields a monthly period", () => {
    const result = allowance({
      storedTier: "pro",
      subscriptions: [subscription("pro", new Date("2026-03-10T00:00:00.000Z"), "year")],
      now: new Date("2026-07-20T00:00:00.000Z"),
    });
    expect(isoPeriod(result.period)).toEqual({ start: "2026-07-10T00:00:00.000Z", end: "2026-08-10T00:00:00.000Z" });
  });

  it("C-11 a pro subscription row without an anchor falls back to the registration time", () => {
    const result = allowance({ storedTier: "pro", subscriptions: [subscription("pro", null)] });
    expect(result.anchor.toISOString()).toBe(REGISTERED.toISOString());
    expect(result.monthly).toBe(4000);
  });

  it("C-12 a manually assigned pro tier with no subscription uses the registration time", () => {
    const result = allowance({ storedTier: "pro" });
    expect(result.anchor.toISOString()).toBe(REGISTERED.toISOString());
  });

  it("C-13 a base account registered on 31 May at 23:30 gets 500 operations in a period clamped to 30 November", () => {
    const registeredAt = new Date("2026-05-31T23:30:00.000Z");
    const result = allowance({ storedTier: "base", registeredAt, now: new Date("2026-11-15T00:00:00.000Z") });
    expect(result.monthly).toBe(500);
    expect(result.anchor.toISOString()).toBe(registeredAt.toISOString());
    expect(isoPeriod(result.period)).toEqual({ start: "2026-10-31T23:30:00.000Z", end: "2026-11-30T23:30:00.000Z" });
  });

  it.each([
    { paymentEnabled: true, storedTier: "pro" as const, charging: true },
    { paymentEnabled: true, storedTier: "self_hosted" as const, charging: false },
    { paymentEnabled: false, storedTier: "pro" as const, charging: false },
    { paymentEnabled: false, storedTier: "self_hosted" as const, charging: false },
  ])("C-14 payments $paymentEnabled with tier $storedTier charges: $charging", ({ paymentEnabled, storedTier, charging }) => {
    expect(allowance({ storedTier, paymentEnabled }).charging).toBe(charging);
  });

  it("C-15 an active enterprise uses its agreement's monthly operations and resets on the agreement's first-save day", () => {
    const enterprise = agreement("2026-07-31T08:00:00.000Z", "2030-01-01T00:00:00.000Z", 20000);
    const at = (now: string): ReturnType<typeof operationAllowanceOf> => allowance({ storedTier: "enterprise", enterprise, now: new Date(now) });
    expect(at("2026-09-30T09:00:00.000Z").monthly).toBe(20000);
    expect(at("2026-09-30T09:00:00.000Z").anchor.toISOString()).toBe("2026-07-31T08:00:00.000Z");
    expect(isoPeriod(at("2026-09-30T09:00:00.000Z").period)).toEqual({ start: "2026-09-30T08:00:00.000Z", end: "2026-10-31T08:00:00.000Z" });
    expect(isoPeriod(at("2026-11-15T00:00:00.000Z").period)).toEqual({ start: "2026-10-31T08:00:00.000Z", end: "2026-11-30T08:00:00.000Z" });
    expect(isoPeriod(at("2027-02-28T09:00:00.000Z").period)).toEqual({ start: "2027-02-28T08:00:00.000Z", end: "2027-03-31T08:00:00.000Z" });
  });

  it("C-17 an enterprise account without an agreement gets 16000 operations anchored at registration, without throwing", () => {
    expect(() => allowance({ storedTier: "enterprise", enterprise: null })).not.toThrow();
    const result = allowance({ storedTier: "enterprise", enterprise: null });
    expect(result.monthly).toBe(16000);
    expect(result.anchor.toISOString()).toBe(REGISTERED.toISOString());
  });

  it("C-18 an expired enterprise that falls back to base gets 500 operations anchored at registration", () => {
    const enterprise = agreement("2026-07-31T08:00:00.000Z", "2026-11-01T00:00:00.000Z", 20000);
    const result = allowance({ storedTier: "enterprise", enterprise });
    expect(result.monthly).toBe(500);
    expect(result.anchor.toISOString()).toBe(REGISTERED.toISOString());
  });

  it("5.1 #3 an expired enterprise whose effective tier is pro through a live pro subscription uses that subscription's anchor", () => {
    const enterprise = agreement("2026-07-31T08:00:00.000Z", "2026-11-01T00:00:00.000Z", 20000);
    const result = allowance({ storedTier: "enterprise", enterprise, subscriptions: [subscription("pro", SUB_ANCHOR)] });
    expect(result.monthly).toBe(4000);
    expect(result.anchor.toISOString()).toBe(SUB_ANCHOR.toISOString());
  });
});
