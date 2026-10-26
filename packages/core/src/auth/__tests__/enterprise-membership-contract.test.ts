// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { enterpriseMembershipWriteSchema, enterpriseMembershipResultSchema, enterpriseMembershipProfileSchema, enterpriseMembershipReadingSchema, enterpriseRecordSchema } from "../enterprise-membership-contract.js";

const id = "00000000-0000-4000-8000-000000000029";
const limits = { team_studios: 8, projects_per_studio: 500, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776 };
const body = { targetTier: "enterprise", expiresAt: "2027-10-26T00:00:00.000Z", entryTimezone: "UTC", contractNumber: "DEMO-ENT-29", limits, expectedRevision: null, expectedStoredTier: "pro" };
const record = { expiresAt: body.expiresAt, entryTimezone: "UTC", contractNumber: body.contractNumber, limits, fallbackTier: "base", revision: 1, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z" };
const result = { status: "applied", operation: { key: `bo-${id}`, accountId: id, adminId: "admin-one", requestHash: "a".repeat(64), recordedAt: record.createdAt }, before: { userId: id, storedTier: "pro", enterprise: null }, after: { userId: id, storedTier: "enterprise", enterprise: record } };

describe("enterprise membership contract", () => {
  it("accepts a complete write and normalizes the contract", () => {
    expect(enterpriseMembershipWriteSchema.parse({ ...body, contractNumber: "  DEMO-ENT-29  " })).toEqual(body);
  });
  it.each(["", " ", "x\u0000", "x".repeat(129)])("rejects invalid contract %j", (contractNumber) => {
    expect(enterpriseMembershipWriteSchema.safeParse({ ...body, contractNumber }).success).toBe(false);
  });
  it.each(["No/Such_Zone", "+08:00", "", "CST"])("rejects invalid timezone %j", (entryTimezone) => {
    expect(enterpriseMembershipWriteSchema.safeParse({ ...body, entryTimezone }).success).toBe(false);
  });
  it("rejects incomplete or unknown fields and invalid revisions", () => {
    expect(enterpriseMembershipWriteSchema.safeParse({ ...body, extra: true }).success).toBe(false);
    expect(enterpriseMembershipWriteSchema.safeParse({ ...body, expectedRevision: 0 }).success).toBe(false);
    expect(enterpriseMembershipWriteSchema.safeParse({ ...body, limits: { ...limits, project_members: undefined } }).success).toBe(false);
  });
  it("checks all count bounds and preserves zero", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2147483647 }), (n) => {
      expect(enterpriseMembershipWriteSchema.parse({ ...body, limits: { ...limits, team_studios: n } }).limits.team_studios).toBe(n);
    }));
    for (const n of [-1, 0.5, 2147483648]) expect(enterpriseMembershipWriteSchema.safeParse({ ...body, limits: { ...limits, team_studios: n } }).success).toBe(false);
    expect(enterpriseMembershipWriteSchema.safeParse({ ...body, limits: { ...limits, storage_bytes: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
  });
  it("checks persisted response identity and revision relationships", () => {
    expect(enterpriseMembershipResultSchema.parse(result)).toEqual(result);
    const updated = { ...result, before: result.after, after: { ...result.after, enterprise: { ...record, revision: 2 } } };
    expect(enterpriseMembershipResultSchema.parse(updated)).toEqual(updated);
    expect(enterpriseMembershipResultSchema.safeParse({ ...result, after: { ...result.after, userId: "00000000-0000-4000-8000-000000000030" } }).success).toBe(false);
    expect(enterpriseMembershipResultSchema.safeParse({ ...result, after: { ...result.after, enterprise: { ...record, revision: 2 } } }).success).toBe(false);
  });
  it("requires unchanged refusal snapshots and null missing-account snapshots", () => {
    const refused = { status: "refused", operation: result.operation, code: "revision_conflict", before: result.before, after: result.before };
    expect(enterpriseMembershipResultSchema.parse(refused)).toEqual(refused);
    expect(enterpriseMembershipResultSchema.safeParse({ ...refused, after: result.after }).success).toBe(false);
    expect(enterpriseMembershipResultSchema.safeParse({ ...refused, code: "account_not_found" }).success).toBe(false);
    expect(enterpriseMembershipResultSchema.safeParse({ ...refused, code: "account_not_found", before: null, after: null }).success).toBe(true);
  });
  it("validates profile identity and the metadata of the exact snapshot", () => {
    const reading = { asOf: record.createdAt, enterpriseState: "active", effectiveTier: "enterprise", limits, storageBytes: null, revision: 1, expiresAt: record.expiresAt, fallbackTier: "base", settlementProtected: true };
    const profile = { account: { id, email: "owner@example.test" }, snapshot: result.after, reading };
    expect(enterpriseMembershipProfileSchema.parse(profile)).toEqual(profile);
    expect(enterpriseMembershipProfileSchema.safeParse({ ...profile, account: { ...profile.account, id: "00000000-0000-4000-8000-000000000030" } }).success).toBe(false);
    for (const changed of [{ revision: 2 }, { expiresAt: "2028-01-01T00:00:00.000Z" }, { fallbackTier: "self_hosted" }]) {
      expect(enterpriseMembershipProfileSchema.safeParse({ ...profile, reading: { ...reading, ...changed } }).success).toBe(false);
    }
    const ordinary = { ...profile, snapshot: result.before, reading: { ...reading, enterpriseState: "ordinary", effectiveTier: "pro", revision: null, expiresAt: null, fallbackTier: null, settlementProtected: false } };
    expect(enterpriseMembershipProfileSchema.parse(ordinary)).toEqual(ordinary);
  });

  it.each(["base", "pro", "team", "self_hosted"] as const)("preserves ordinary %s count limits above the negotiated count range", (effectiveTier) => {
    fc.assert(fc.property(fc.integer({ min: 2147483648, max: Number.MAX_SAFE_INTEGER }), (count) => {
      const configured = { team_studios: count, projects_per_studio: count, concurrent_editors: count, studio_members: count, project_members: count, storage_bytes: Number.MAX_SAFE_INTEGER };
      const profile = {
        account: { id, email: "owner@example.test" },
        snapshot: { userId: id, storedTier: effectiveTier, enterprise: null },
        reading: { asOf: record.createdAt, enterpriseState: "ordinary", effectiveTier, limits: configured, storageBytes: configured.storage_bytes, revision: null, expiresAt: null, fallbackTier: null, settlementProtected: effectiveTier === "self_hosted" },
      };
      expect(enterpriseMembershipProfileSchema.parse(profile)).toEqual(profile);
    }), { examples: [[2147483648], [Number.MAX_SAFE_INTEGER]] });
  });

  it.each(["base", "self_hosted"] as const)("preserves large configured limits after expiry to %s", (fallbackTier) => {
    const configured = { team_studios: 2147483648, projects_per_studio: 2147483648, concurrent_editors: 2147483648, studio_members: 2147483648, project_members: 2147483648, storage_bytes: Number.MAX_SAFE_INTEGER };
    const expired = { ...record, expiresAt: "2000-01-01T00:00:00.000Z", fallbackTier };
    const profile = {
      account: { id, email: "owner@example.test" },
      snapshot: { userId: id, storedTier: "enterprise", enterprise: expired },
      reading: { asOf: record.createdAt, enterpriseState: "expired", effectiveTier: fallbackTier, limits: configured, storageBytes: configured.storage_bytes, revision: expired.revision, expiresAt: expired.expiresAt, fallbackTier, settlementProtected: fallbackTier === "self_hosted" },
    };
    expect(enterpriseMembershipProfileSchema.parse(profile)).toEqual(profile);
  });

  it.each(["team_studios", "projects_per_studio", "concurrent_editors", "studio_members", "project_members"] as const)("retains the enterprise int32 bound for %s at every contract boundary", (field) => {
    const oversized = { ...limits, [field]: 2147483648 };
    const malformed = { ...record, limits: oversized };
    const active = { asOf: record.createdAt, enterpriseState: "active", effectiveTier: "enterprise", limits: oversized, storageBytes: null, revision: record.revision, expiresAt: record.expiresAt, fallbackTier: record.fallbackTier, settlementProtected: true };
    expect(enterpriseMembershipWriteSchema.safeParse({ ...body, limits: oversized }).success).toBe(false);
    expect(enterpriseRecordSchema.safeParse(malformed).success).toBe(false);
    expect(enterpriseMembershipResultSchema.safeParse({ ...result, after: { ...result.after, enterprise: malformed } }).success).toBe(false);
    expect(enterpriseMembershipReadingSchema.safeParse(active).success).toBe(false);
    expect(enterpriseMembershipProfileSchema.safeParse({ account: { id, email: "owner@example.test" }, snapshot: result.after, reading: active }).success).toBe(false);
  });

  it("retains strict ordinary reading fields and numeric validity", () => {
    const ordinary = { asOf: record.createdAt, enterpriseState: "ordinary", effectiveTier: "self_hosted", limits, storageBytes: limits.storage_bytes, revision: null, expiresAt: null, fallbackTier: null, settlementProtected: true };
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(enterpriseMembershipReadingSchema.safeParse({ ...ordinary, limits: { ...limits, projects_per_studio: value } }).success).toBe(false);
    }
    expect(enterpriseMembershipReadingSchema.safeParse({ ...ordinary, limits: { ...limits, extra: 1 } }).success).toBe(false);
  });

  it("retains management profile identity and mailbox validation", () => {
    const profile = {
      account: { id, email: "owner@example.test" }, snapshot: result.before,
      reading: { asOf: record.createdAt, enterpriseState: "ordinary", effectiveTier: "pro", limits, storageBytes: limits.storage_bytes, revision: null, expiresAt: null, fallbackTier: null, settlementProtected: false },
    };
    const legacyId = "00000000-0000-0000-0000-0000000e0029";
    expect(enterpriseMembershipProfileSchema.safeParse({ ...profile, account: { ...profile.account, id: legacyId }, snapshot: { ...profile.snapshot, userId: legacyId } }).success).toBe(false);
    expect(enterpriseMembershipProfileSchema.safeParse({ ...profile, account: { ...profile.account, email: "legacy-mailbox" } }).success).toBe(false);
  });
});
