// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import * as shared from "@shared/index.js";

type CreditSchemaName =
  | "purchaseRowSchema"
  | "creditLotViewSchema"
  | "studioLotViewSchema"
  | "creditLedgerViewSchema"
  | "studioLedgerViewSchema"
  | "projectCreditsViewSchema"
  | "studioCreditsViewSchema"
  | "studioCreditSummarySchema"
  | "creditOverviewSchema";

interface RuntimeCreditSchema {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean };
}

interface ViewCase {
  name: CreditSchemaName;
  value: Record<string, unknown>;
  amountFields: readonly string[];
  requiredAmounts: readonly string[];
}

const ID = "00000000-0000-4000-8000-000000000144";
const STUDIO = "00000000-0000-4000-8000-000000000244";
const AT = "2026-10-31T00:00:00.000Z";
const lot = {
  id: ID, sourceKind: "compensation", purchasedCredits: "100.000000", remainingCredits: "80.000000",
  designatedStudioId: STUDIO, designatedStudioName: "Credit demo", designated: true,
  paidCents: null, currency: null, lifecycle: "active", refundAttempts: 0, everSpent: true, everRestored: false, createdAt: AT,
};
const studioLot = { id: ID, purchasedCredits: "100.000000", remainingCredits: "80.000000", createdAt: AT, buyerName: "Credit owner" };
const ledger = {
  id: ID, kind: "debt_repayment", actorUserId: null, actorName: null,
  studioId: STUDIO, studioName: "Credit demo", projectId: null, projectName: null,
  model: null, provider: null, amount: "-20.000000", createdAt: AT,
};
const studioLedger = {
  id: ID, kind: "generation", actorUserId: null, actorName: null,
  projectId: null, projectName: null, model: null, provider: null,
  charged: "20.000000", consumed: "25.000000", owed: "5.000000", createdAt: AT,
};
const summary = {
  studioId: STUDIO, studioName: "Credit demo", studioSlug: "credit-demo", deleted: false,
  spendable: "80.000000", debt: "20.000000", spent: "20.000000", lotCount: 1,
};
const purchase = {
  rowId: ID, sourceKind: "payment", paymentId: ID,
  amountCents: 500, totalCents: 550, taxCents: 50, currency: "usd",
  creditsGranted: "100.000000", remainingCredits: "80.000000", lifecycle: "active",
  designatedStudioId: STUDIO, designatedStudioName: "Credit demo", status: "completed", createdAt: AT, canResend: true,
};

const cases: readonly ViewCase[] = [
  { name: "purchaseRowSchema", value: purchase, amountFields: ["creditsGranted", "remainingCredits"], requiredAmounts: ["creditsGranted", "remainingCredits"] },
  { name: "creditLotViewSchema", value: lot, amountFields: ["purchasedCredits", "remainingCredits"], requiredAmounts: ["purchasedCredits", "remainingCredits"] },
  { name: "studioLotViewSchema", value: studioLot, amountFields: ["purchasedCredits", "remainingCredits"], requiredAmounts: ["purchasedCredits", "remainingCredits"] },
  { name: "creditLedgerViewSchema", value: ledger, amountFields: ["amount"], requiredAmounts: ["amount"] },
  { name: "studioLedgerViewSchema", value: studioLedger, amountFields: ["charged", "consumed", "owed"], requiredAmounts: ["charged", "consumed", "owed"] },
  { name: "projectCreditsViewSchema", value: { spendable: "80.000000", held: "30.000000", available: "50.000000" }, amountFields: ["spendable", "held", "available"], requiredAmounts: ["spendable", "held", "available"] },
  { name: "studioCreditsViewSchema", value: { spendable: "80.000000", debt: "20.000000", held: "30.000000", available: "50.000000", lots: [studioLot], ledger: { items: [studioLedger], nextCursor: null } }, amountFields: ["spendable", "debt", "held", "available"], requiredAmounts: [] },
  { name: "studioCreditSummarySchema", value: summary, amountFields: ["spendable", "debt", "spent"], requiredAmounts: ["spendable", "debt", "spent"] },
  { name: "creditOverviewSchema", value: { assignedCredits: "80.000000", unassignedCredits: "0.000000", underRefundCredits: "0.000000", billing: true, studios: [summary] }, amountFields: ["assignedCredits", "unassignedCredits", "underRefundCredits"], requiredAmounts: ["assignedCredits", "unassignedCredits", "underRefundCredits"] },
];

/**
 * Obtain the schema promised to both producers and consumers.
 * @param name - The public view-schema entry.
 * @returns Its runtime parser.
 * @throws {Error} When a shared view contract has not been exported.
 */
function schema(name: CreditSchemaName): RuntimeCreditSchema {
  const candidate = (shared as unknown as Record<CreditSchemaName, RuntimeCreditSchema>)[name];
  expect(typeof candidate?.parse, `${name}.parse`).toBe("function");
  expect(typeof candidate?.safeParse, `${name}.safeParse`).toBe("function");
  return candidate;
}

describe.each(cases)("$name precise wire contract (inner#1411)", ({ name, value, amountFields, requiredAmounts }) => {
  it("accepts six-place decimal strings and preserves the complete view", () => {
    const parsed = schema(name).parse(value);
    expect(parsed).toEqual(value);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(value);
  });

  it.each(amountFields)("rejects a number in %s", (field) => {
    expect(schema(name).safeParse({ ...value, [field]: Number(value[field]) }).success).toBe(false);
  });

  it.each(amountFields)("rejects a seventh decimal digit in %s", (field) => {
    expect(schema(name).safeParse({ ...value, [field]: `${String(value[field])}0` }).success).toBe(false);
  });

  for (const field of requiredAmounts) {
    it(`rejects a missing required amount in ${field}`, () => {
      const without = { ...value };
      delete without[field];
      expect(schema(name).safeParse(without).success).toBe(false);
    });
  }
});

describe("credit view nullability, paging and other units", () => {
  it("keeps a purchase that has not opened credits with null remaining and lifecycle", () => {
    const pending = { ...purchase, remainingCredits: null, lifecycle: null, status: "pending", designatedStudioId: null, designatedStudioName: null, canResend: false };
    expect(schema("purchaseRowSchema").parse(pending)).toEqual(pending);
  });

  it("keeps cash cents as numbers beside precise credit strings", () => {
    const parsed = schema("purchaseRowSchema").parse(purchase) as typeof purchase;
    expect([parsed.amountCents, parsed.totalCents, parsed.taxCents]).toEqual([500, 550, 50]);
    expect(parsed.creditsGranted).toBe("100.000000");
    expect(parsed.remainingCredits).toBe("80.000000");
  });

  it("keeps an unassigned lot's nullable cash and studio fields", () => {
    const unassigned = { ...lot, designatedStudioId: null, designatedStudioName: null, designated: false, paidCents: null, currency: null };
    expect(schema("creditLotViewSchema").parse(unassigned)).toEqual(unassigned);
  });

  it("keeps summary counts numeric and an unavailable studio debt null", () => {
    const noDebtReading = { ...summary, debt: null };
    expect(schema("studioCreditSummarySchema").parse(noDebtReading)).toEqual(noDebtReading);
    expect((schema("studioCreditSummarySchema").parse(summary) as typeof summary).lotCount).toBe(1);
  });

  it("accepts a Studio ledger page with the first-page amounts absent", () => {
    const page = { ledger: { items: [studioLedger], nextCursor: "opaque-next-cursor" } };
    expect(schema("studioCreditsViewSchema").parse(page)).toEqual(page);
  });

  it("validates the amounts inside a Studio ledger page", () => {
    const page = { ledger: { items: [{ ...studioLedger, charged: 20 }], nextCursor: null } };
    expect(schema("studioCreditsViewSchema").safeParse(page).success).toBe(false);
  });

  it("validates the amounts inside a Studio lot list", () => {
    const firstPage = { spendable: "80.000000", debt: "20.000000", held: "0.000000", available: "80.000000", lots: [{ ...studioLot, remainingCredits: 80 }], ledger: { items: [], nextCursor: null } };
    expect(schema("studioCreditsViewSchema").safeParse(firstPage).success).toBe(false);
  });

  it("validates each studio's summary inside an account overview", () => {
    const overview = { assignedCredits: "80.000000", unassignedCredits: "0.000000", underRefundCredits: "0.000000", billing: true, studios: [{ ...summary, spent: 20 }] };
    expect(schema("creditOverviewSchema").safeParse(overview).success).toBe(false);
  });

  it("accepts an aggregate beyond one numeric row in an account overview", () => {
    const overview = { assignedCredits: "199999999999999.999998", unassignedCredits: "0.000000", underRefundCredits: "0.000001", billing: true, studios: [] };
    expect(schema("creditOverviewSchema").parse(overview)).toEqual(overview);
  });
});
