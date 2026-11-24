// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as core from "@core/index.js";

interface RuntimeSchema { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }
type ContractName = "enterpriseCreditPurchaseWriteSchema" | "enterpriseCreditPurchaseResultSchema" | "enterpriseCreditPurchaseProfileSchema";
const USER = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000002";
const LOT = "00000000-0000-4000-8000-000000000003";
const KEY = "bo-00000000-0000-4000-8000-000000000004";
const BODY = { credits: "100.00", reason: "Confirmed corporate purchase", expectedEnterpriseRevision: 3, expectedContractNumber: "CONTRACT-174" };
const OPERATION = { key: KEY, accountId: USER, adminId: ADMIN, requestHash: "a".repeat(64), recordedAt: "2026-11-19T00:00:00.000Z" };
const APPLIED = { status: "applied", operation: OPERATION, sourceKind: "enterprise", sourceId: USER, lotId: LOT, credits: "100.000000", contractNumber: "CONTRACT-174", designatedStudioId: null, remainingCredits: "100.000000" };
const PROFILE = { account: { id: USER, email: "enterprise@example.test" }, enterpriseState: "active", revision: 3, contractNumber: "CONTRACT-174", expiresAt: "2027-01-01T00:00:00.000Z", canPurchase: true, reason: null };

/** Locate the specified contract through the public core entry. */
function schema(name: ContractName): RuntimeSchema {
  const candidate = (core as unknown as Record<string, RuntimeSchema | undefined>)[name];
  expect(typeof candidate?.parse, `${name} must be exported by core`).toBe("function");
  return candidate!;
}

describe("enterprise credit purchase contract", () => {
  it("normalizes the exact original purchase intent", () => {
    expect(schema("enterpriseCreditPurchaseWriteSchema").parse({ ...BODY, credits: " 100 ", reason: " Confirmed corporate purchase " })).toEqual(BODY);
  });

  it.each(["0.01", "99999999999999.99"])("accepts exact input boundary %s", credits => {
    expect(schema("enterpriseCreditPurchaseWriteSchema").parse({ ...BODY, credits })).toEqual({ ...BODY, credits });
  });

  it.each(["0", "-1", "0.001", "1e2", "Infinity", "", "100000000000000.00"])("rejects invalid credits %s", credits => {
    expect(schema("enterpriseCreditPurchaseWriteSchema").safeParse({ ...BODY, credits }).success).toBe(false);
  });

  it.each([{ expectedEnterpriseRevision: 0 }, { expectedEnterpriseRevision: null }, { expectedEnterpriseRevision: 1.5 }, { expectedContractNumber: "" }, { expectedContractNumber: "x".repeat(129) }, { reason: "" }, { reason: "x".repeat(501) }, { reason: "bad\u0000reason" }, { studioId: LOT }])("rejects invalid purchase facts %#", change => {
    expect(schema("enterpriseCreditPurchaseWriteSchema").safeParse({ ...BODY, ...change }).success).toBe(false);
  });

  it("retains an exact applied creation snapshot", () => {
    expect(schema("enterpriseCreditPurchaseResultSchema").parse(APPLIED)).toEqual(APPLIED);
  });

  it.each([{ credits: "0.000000", remainingCredits: "0.000000" }, { remainingCredits: "99.000000" }, { designatedStudioId: LOT }, { sourceKind: "payment" }, { contractNumber: "" }, { operation: { ...OPERATION, adminId: "invalid" } }, { extra: true }])("rejects an invalid creation result %#", change => {
    expect(schema("enterpriseCreditPurchaseResultSchema").safeParse({ ...APPLIED, ...change }).success).toBe(false);
  });

  it.each(["account_not_found", "not_enterprise", "enterprise_expired", "enterprise_missing", "enterprise_changed", "payments_disabled"])("retains finite refusal %s", code => {
    const answer = { status: "refused", operation: OPERATION, code };
    expect(schema("enterpriseCreditPurchaseResultSchema").parse(answer)).toEqual(answer);
  });

  it("rejects an arbitrary refusal", () => {
    expect(schema("enterpriseCreditPurchaseResultSchema").safeParse({ status: "refused", operation: OPERATION, code: "anything" }).success).toBe(false);
  });

  it("retains a complete currently eligible enterprise profile", () => {
    expect(schema("enterpriseCreditPurchaseProfileSchema").parse(PROFILE)).toEqual(PROFILE);
  });

  it.each([
    { enterpriseState: "ordinary", revision: null, contractNumber: null, expiresAt: null, canPurchase: false, reason: "not_enterprise" },
    { enterpriseState: "missing", revision: null, contractNumber: null, expiresAt: null, canPurchase: false, reason: "enterprise_missing" },
    { enterpriseState: "expired", canPurchase: false, reason: "enterprise_expired" },
    { canPurchase: false, reason: "payments_disabled" },
  ])("retains explicit ineligible profile %#", change => {
    expect(schema("enterpriseCreditPurchaseProfileSchema").parse({ ...PROFILE, ...change })).toEqual({ ...PROFILE, ...change });
  });

  it.each([{ revision: null }, { contractNumber: null }, { expiresAt: null }, { enterpriseState: "ordinary" }, { canPurchase: false }, { reason: "enterprise_expired" }])("rejects contradictory eligibility %#", change => {
    expect(schema("enterpriseCreditPurchaseProfileSchema").safeParse({ ...PROFILE, ...change }).success).toBe(false);
  });

  it("preserves exact purchased quantities through the result contract", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 9999999999999999n }), cents => {
      const credits = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}0000`;
      const value = { ...APPLIED, credits, remainingCredits: credits };
      expect(schema("enterpriseCreditPurchaseResultSchema").parse(value)).toEqual(value);
    }));
  });
});
