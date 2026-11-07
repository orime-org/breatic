// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import * as core from "@core/index.js";

interface RuntimeSchema { parse: (value: unknown) => unknown; safeParse: (value: unknown) => { success: boolean } }
type ContractName = "creditGrantWriteSchema" | "creditGrantResultSchema" | "creditGrantProfileSchema";
const U = "00000000-0000-4000-8000-000000000001";
const P = "00000000-0000-4000-8000-000000000002";
const A = "00000000-0000-4000-8000-000000000003";
const KEY = "bo-00000000-0000-4000-8000-000000000004";
const BODY = { kind: "compensation", credits: "100.00", reason: "Service compensation", expectedPersonalStudioId: P };
const OPERATION = { key: KEY, accountId: U, adminId: A, requestHash: "a".repeat(64), recordedAt: "2026-10-31T00:00:00.000Z" };
const APPLIED = { status: "applied", operation: OPERATION, sourceId: U, sourceKind: "compensation", lotId: P, personalStudioId: P,
  grantedCredits: "100.000000", repaidCredits: "20.000000", remainingCredits: "80.000000", debtBefore: "20.000000", debtAfter: "0.000000" };

/** Locate the agreed contract through the existing public entry at assertion time. */
function schema(name: ContractName): RuntimeSchema {
  const candidate = (core as unknown as Record<string, RuntimeSchema | undefined>)[name];
  expect(typeof candidate?.parse, `${name} must be exported by the core public entry`).toBe("function");
  return candidate!;
}

describe("operator credit grant wire contract", () => {
  it.each(["compensation", "gift"])("P01 normalizes a %s original intent", (kind) => {
    expect(schema("creditGrantWriteSchema").parse({ ...BODY, kind, credits: " 100 ", reason: " Service compensation " }))
      .toEqual({ ...BODY, kind });
  });

  it.each(["0.01", "99999999999999.99"])("P01 accepts the exact input boundary %s", (credits) => {
    expect(schema("creditGrantWriteSchema").parse({ ...BODY, credits })).toEqual({ ...BODY, credits });
  });

  it.each(["", "0", "-1", "1e2", "NaN", "Infinity", "0.001", "100000000000000.00"])("P01 rejects invalid grant credits %s", (credits) => {
    expect(schema("creditGrantWriteSchema").safeParse({ ...BODY, credits }).success).toBe(false);
  });

  it.each(["", " ", "x".repeat(501)])("P01 rejects invalid reason case %#", (reason) => {
    expect(schema("creditGrantWriteSchema").safeParse({ ...BODY, reason }).success).toBe(false);
  });

  it.each([1, 500])("P01 accepts a reason of %i characters", (length) => {
    expect(schema("creditGrantWriteSchema").parse({ ...BODY, reason: "x".repeat(length) })).toEqual({ ...BODY, reason: "x".repeat(length) });
  });

  it.each([{ ...BODY, studioId: P }, { ...BODY, kind: "discount" }, { ...BODY, expectedPersonalStudioId: "invalid" }, { ...BODY, credits: 100 }])("P01 rejects an invalid body shape %#", (value) => {
    expect(schema("creditGrantWriteSchema").safeParse(value).success).toBe(false);
  });

  it("P02 accepts the exact applied relationships", () => {
    expect(schema("creditGrantResultSchema").parse(APPLIED)).toEqual(APPLIED);
  });

  it.each([
    { remainingCredits: "81.000000" }, { debtAfter: "1.000000" }, { grantedCredits: "-100.000000" },
    { repaidCredits: "101.000000", remainingCredits: "0.000000" }, { repaidCredits: "21.000000", remainingCredits: "79.000000", debtAfter: "0.000000" },
    { remainingCredits: 80 }, { remainingCredits: "80.0000001" }, { extra: true },
  ])("P02 rejects a broken result relationship %#", (change) => {
    expect(schema("creditGrantResultSchema").safeParse({ ...APPLIED, ...change }).success).toBe(false);
  });

  it.each(["account_not_found", "personal_studio_unavailable", "personal_studio_changed", "payments_disabled"])("P01 accepts the finite refusal %s", (code) => {
    const result = { status: "refused", operation: OPERATION, code };
    expect(schema("creditGrantResultSchema").parse(result)).toEqual(result);
  });

  it("P01 rejects a refusal outside the finite contract", () => {
    expect(schema("creditGrantResultSchema").safeParse({ status: "refused", operation: OPERATION, code: "anything" }).success).toBe(false);
  });

  it.each([{}, { key: "not-a-key" }, { accountId: "not-a-user" }, { recordedAt: "yesterday" }, { requestHash: "z".repeat(64) }])("P01 rejects an invalid operation identity %#", (change) => {
    const operation = Object.keys(change).length === 0 ? undefined : { ...OPERATION, ...change };
    expect(schema("creditGrantResultSchema").safeParse({ ...APPLIED, operation }).success).toBe(false);
  });

  it("P01 parses a grantable personal Studio profile", () => {
    const profile = { account: { id: U, email: "operator-profile@example.test" }, personalStudio: { id: P, name: "Personal", slug: "personal" }, debtCredits: "20.000000", canGrant: true, reason: null };
    expect(schema("creditGrantProfileSchema").parse(profile)).toEqual(profile);
  });

  it("P01 preserves an explicit unavailable personal Studio", () => {
    const profile = { account: { id: U, email: "operator-profile@example.test" }, personalStudio: null, debtCredits: null, canGrant: false, reason: "personal_studio_unavailable" };
    expect(schema("creditGrantProfileSchema").parse(profile)).toEqual(profile);
  });
});
