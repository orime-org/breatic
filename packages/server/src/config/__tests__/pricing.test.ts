// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The price file's schema (task #13).
 *
 * What a tier's currency is written as decides whether every purchase can be
 * settled. `fulfillPayment` compares the currency on our own row against the
 * one Stripe reports, and Stripe always answers in lower case; a tier written
 * `USD` — which is how ISO 4217 is normally written — therefore disagrees with
 * Stripe on every purchase, the comparison returns `mismatch` before the
 * transaction opens, and the buyer's money is taken while no credits are
 * granted. Normalising where the file enters the system is what keeps the
 * stored currency comparable, for the comparison and for a later refund.
 */

import { describe, it, expect } from "vitest";
import { pricingSchema } from "@server/config/pricing.js";

/** One tier, with only the field under test varying. */
function tier(currency?: string): Record<string, unknown> {
  return {
    name: "830 Credits",
    credits: 830,
    price_cents: 1000,
    ...(currency === undefined ? {} : { currency }),
    stripe_price_id: { test: "price_test", live: "price_live" },
  };
}

describe("the price file's currency", () => {
  it.each(["USD", "Usd", "uSD"])("stores %s as lower case", (written) => {
    const parsed = pricingSchema.parse({ tiers: [tier(written)] });
    expect(parsed.tiers[0]!.currency).toBe("usd");
  });

  it("defaults to usd when a tier names none", () => {
    const parsed = pricingSchema.parse({ tiers: [tier()] });
    expect(parsed.tiers[0]!.currency).toBe("usd");
  });

  // The three cases above all expect `usd`, so on their own they pass just as
  // well against a schema that writes every currency to `usd` — and that
  // schema would take a tier priced in euros and hand Stripe dollars. These
  // are what separates lowercasing from overwriting.
  it.each(["eur", "jpy"])("leaves %s as the tier wrote it", (written) => {
    const parsed = pricingSchema.parse({ tiers: [tier(written)] });
    expect(parsed.tiers[0]!.currency).toBe(written);
  });
});
