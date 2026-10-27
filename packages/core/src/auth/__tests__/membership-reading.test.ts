// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveMembershipReading } from "../membership-reading.js";

const expiresAt = "2026-10-25T00:00:00.000Z";
const limits = { team_studios: 0, projects_per_studio: 20, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776 };
const record = { expiresAt, entryTimezone: "UTC", contractNumber: "ENT-29", limits, fallbackTier: "base" as const, revision: 1, createdAt: expiresAt, updatedAt: expiresAt };

describe("membership reading from one snapshot", () => {
  it("uses an exclusive deadline at the exact boundary", () => {
    expect(resolveMembershipReading("enterprise", record, [], { now: new Date(Date.parse(expiresAt) - 1), staleAfterMs: 0 })).toMatchObject({ enterpriseState: "active", effectiveTier: "enterprise", limits, storageBytes: null, settlementProtected: true });
    expect(resolveMembershipReading("enterprise", record, [], { now: new Date(expiresAt), staleAfterMs: 0 })).toMatchObject({ enterpriseState: "expired", effectiveTier: "base", settlementProtected: false });
  });
  it("keeps self-hosted origin protected after expiry", () => {
    expect(resolveMembershipReading("enterprise", { ...record, fallbackTier: "self_hosted" }, [], { now: new Date(expiresAt), staleAfterMs: 0 })).toMatchObject({ effectiveTier: "self_hosted", settlementProtected: true });
  });
  it("retains legacy enterprise without inventing limits", () => {
    expect(resolveMembershipReading("enterprise", null, [], { now: new Date(expiresAt), staleAfterMs: 0 })).toMatchObject({ enterpriseState: "missing", effectiveTier: "enterprise", limits: null, storageBytes: null, settlementProtected: true });
  });
  it("preserves ordinary manual tiers and ignores historical enterprise entitlements", () => {
    expect(resolveMembershipReading("pro", record, [], { now: new Date(expiresAt), staleAfterMs: 0 })).toMatchObject({ enterpriseState: "ordinary", effectiveTier: "pro", settlementProtected: false });
  });
  it("reads a paid subscription after SaaS enterprise expiry", () => {
    const facts = [{ stripeSubscriptionId: "sub-one", tier: "team" as const, period: "month" as const, status: "active", cancelAtPeriodEnd: true, hasPendingUpdate: false, currentPeriodEnd: new Date("2070-01-01T00:00:00Z") }];
    expect(resolveMembershipReading("enterprise", record, facts, { now: new Date(expiresAt), staleAfterMs: 0 }).effectiveTier).toBe("team");
  });
  it("applies the ordinary lapsed subscription rule and keeps ordinary self-hosted protected", () => {
    const facts = [{ stripeSubscriptionId: "sub-ended", tier: "team" as const, period: "month" as const, status: "active", cancelAtPeriodEnd: true, hasPendingUpdate: false, currentPeriodEnd: new Date("2000-01-01T00:00:00Z") }];
    expect(resolveMembershipReading("team", null, facts, { now: new Date(expiresAt), staleAfterMs: 0 }).effectiveTier).toBe("base");
    expect(resolveMembershipReading("self_hosted", null, facts, { now: new Date(expiresAt), staleAfterMs: 0 })).toMatchObject({ effectiveTier: "self_hosted", settlementProtected: true });
    expect(resolveMembershipReading("base", null, [], { now: new Date(expiresAt), staleAfterMs: 0 }).effectiveTier).toBe("base");
  });
  it("never reuses expired negotiated limits", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2147483647 }), (projects) => {
      const result = resolveMembershipReading("enterprise", { ...record, limits: { ...limits, projects_per_studio: projects } }, [], { now: new Date(expiresAt), staleAfterMs: 0 });
      expect(result.effectiveTier).toBe("base");
      expect(result.limits).not.toEqual({ ...limits, projects_per_studio: projects });
    }));
  });
});
