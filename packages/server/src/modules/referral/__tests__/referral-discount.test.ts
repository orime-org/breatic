// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { referralConfigSchema } from "@server/config/referral.js";
import { legalConfigSchema } from "@server/config/legal.js";
import { firstPeriodDiscountFor } from "../referral-discount.js";

const TIERS = ["base", "starter", "pro", "team", "enterprise", "self_hosted"] as const;

describe("firstPeriodDiscountFor", () => {
  it("grants the configured percent exactly when bound, not enterprise and never paid", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom(...TIERS),
        fc.boolean(),
        fc.integer({ min: 1, max: 99 }),
        (bound, effectiveTier, paid, percent) => {
          const expected = bound && effectiveTier !== "enterprise" && !paid ? percent : null;
          return firstPeriodDiscountFor({ bound, effectiveTier, paid, percent }) === expected;
        },
      ),
    );
  });

  it("still discounts a binding to a code that was disabled or removed afterwards", () => {
    expect(firstPeriodDiscountFor({ bound: true, effectiveTier: "base", paid: false, percent: 20 })).toBe(20);
  });
});

describe("referral configuration", () => {
  it("defaults the first-period discount to 20 percent", () => {
    expect(referralConfigSchema.parse({}).first_period_discount_percent).toBe(20);
  });

  it.each([0, 100, 12.5, -5])("rejects %s as a discount percent", (value) => {
    expect(() => referralConfigSchema.parse({ first_period_discount_percent: value })).toThrow();
  });

  it("keeps promoter applications closed until a terms version is published", () => {
    expect(legalConfigSchema.parse({}).promoter_terms_version).toBe("");
    expect(legalConfigSchema.parse({ promoter_terms_version: "2026-11-07" }).promoter_terms_version).toBe("2026-11-07");
    expect(() => legalConfigSchema.parse({ promoter_terms_version: "x".repeat(33) })).toThrow();
  });
});
