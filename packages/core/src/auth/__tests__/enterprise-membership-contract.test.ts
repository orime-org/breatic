// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { enterpriseMembershipWriteSchema, enterpriseMembershipResultSchema, enterpriseMembershipProfileSchema } from "../enterprise-membership-contract.js";

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
});
