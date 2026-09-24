// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a Stripe subscription into the row we store (#106 section 5.2 and
 * 8; periods and the price check added in #253 section 1.2).
 *
 * Four facts are the whole difficulty here, and getting any of them wrong
 * fails quietly.
 *
 * The period end is NOT on the subscription. Since the 2025-03-31 release it
 * sits on `items.data[].current_period_end`; reading the old place gives
 * undefined forever, and the lapsed-subscription check can never fire.
 *
 * The offer comes from the price. Nothing Stripe sends carries our word for a
 * tier, and since #253 nothing carries our word for a period either — one
 * lookup answers both.
 *
 * An unpaid upgrade and an unpaid renewal both leave an open invoice, and the
 * two owe the reader different sentences.
 *
 * What Stripe charges is compared against what our own price list says. The
 * two are meant to be the same figure; a price id pasted into the wrong slot,
 * or an amount edited at Stripe, makes them differ, and that difference is
 * the only thing that can show it.
 */

import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";

/** What this deployment sells, as the loader would answer. */
const PLANS = {
  pro: {
    month: { priceCents: 1999, currency: "usd", stripePriceId: "price_pro_m" },
    year: { priceCents: 19999, currency: "usd", stripePriceId: "price_pro_y" },
  },
  team: {
    month: { priceCents: 7999, currency: "usd", stripePriceId: "price_team_m" },
    year: { priceCents: 79999, currency: "usd", stripePriceId: "price_team_y" },
  },
} as const;

const BY_PRICE_ID: Record<string, { tier: string; period: string }> = {
  price_pro_m: { tier: "pro", period: "month" },
  price_pro_y: { tier: "pro", period: "year" },
  price_team_m: { tier: "team", period: "month" },
  price_team_y: { tier: "team", period: "year" },
};

vi.mock("@breatic/core", () => ({
  findOfferByPriceId: (priceId: string) => BY_PRICE_ID[priceId] ?? null,
  getSubscriptionPlan: (tier: "pro" | "team", period: "month" | "year") =>
    PLANS[tier][period],
}));

import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";

const PERIOD_END = 1_789_000_000;

/**
 * A price in the shape Stripe expands it to, agreeing with our list.
 * @param id - The price id, which is what decides tier and period.
 * @returns The price object.
 */
function stripePrice(id: string): Record<string, unknown> {
  const offer = BY_PRICE_ID[id]!;
  const plan = PLANS[offer.tier as "pro" | "team"][offer.period as "month" | "year"];
  return {
    id,
    unit_amount: plan.priceCents,
    currency: plan.currency,
    recurring: { interval: offer.period },
  };
}

/**
 * A Stripe subscription in the shape the SDK hands back.
 * @param over - The fields one case cares about.
 * @returns A subscription object.
 */
function stripeSub(over: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    pending_update: null,
    latest_invoice: null,
    items: {
      data: [
        {
          id: "si_1",
          current_period_end: PERIOD_END,
          price: stripePrice("price_pro_m"),
        },
      ],
    },
    ...over,
  } as unknown as Stripe.Subscription;
}

/**
 * One subscription item, for the cases that replace the default.
 * @param priceId - Which price it sells.
 * @param priceOver - Fields of the price this case disagrees on.
 * @returns An items payload.
 */
function itemsSelling(
  priceId: string,
  priceOver: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: [
      {
        id: "si_1",
        current_period_end: PERIOD_END,
        price: { ...stripePrice(priceId), ...priceOver },
      },
    ],
  };
}

describe("readStripeSubscription — what it reads", () => {
  it("takes the period end off the item, where Stripe moved it", () => {
    // On the subscription itself the field no longer exists. Reading there
    // gives undefined and the lapsed-subscription check silently never fires.
    const read = readStripeSubscription(stripeSub(), "u-1");
    expect(read.ok).toBe(true);
    expect(read.ok && read.write.currentPeriodEnd?.getTime()).toBe(
      PERIOD_END * 1000,
    );
  });

  it("reads the tier AND the period from the one price", () => {
    const read = readStripeSubscription(
      stripeSub({ items: itemsSelling("price_team_y") }),
      "u-1",
    );
    expect(read.ok && read.write.tier).toBe("team");
    expect(read.ok && read.write.period).toBe("year");
  });

  it("copies the status and the scheduled cancellation through", () => {
    const read = readStripeSubscription(
      stripeSub({ status: "past_due", cancel_at_period_end: true }),
      "u-1",
    );
    expect(read.ok && read.write.status).toBe("past_due");
    expect(read.ok && read.write.cancelAtPeriodEnd).toBe(true);
  });

  it("reads a waiting change as both the tier and the period it moves to", () => {
    const read = readStripeSubscription(
      stripeSub({
        pending_update: {
          subscription_items: [{ price: stripePrice("price_team_y") }],
        },
      }),
      "u-1",
    );
    expect(read.ok && read.write.hasPendingUpdate).toBe(true);
    expect(read.ok && read.write.pendingTier).toBe("team");
    expect(read.ok && read.write.pendingPeriod).toBe("year");
  });

  it("says nothing is waiting when nothing is", () => {
    const read = readStripeSubscription(stripeSub(), "u-1");
    expect(read.ok && read.write.hasPendingUpdate).toBe(false);
    expect(read.ok && read.write.pendingTier).toBeNull();
    expect(read.ok && read.write.pendingPeriod).toBeNull();
  });

  it("hands over the payment page only while the invoice is still open", () => {
    const open = readStripeSubscription(
      stripeSub({
        latest_invoice: {
          status: "open",
          hosted_invoice_url: "https://pay.example/inv_1",
        },
      }),
      "u-1",
    );
    expect(open.ok && open.write.payableInvoiceUrl).toBe(
      "https://pay.example/inv_1",
    );

    const paid = readStripeSubscription(
      stripeSub({
        latest_invoice: { status: "paid", hosted_invoice_url: "https://x" },
      }),
      "u-1",
    );
    expect(paid.ok && paid.write.payableInvoiceUrl).toBeNull();
  });

  it("treats an unexpanded invoice as nothing to pay", () => {
    // `latest_invoice` is a bare id unless it was expanded, and an id says
    // nothing about whether anything is owed.
    const read = readStripeSubscription(
      stripeSub({ latest_invoice: "in_123" }),
      "u-1",
    );
    expect(read.ok && read.write.payableInvoiceUrl).toBeNull();
  });
});

describe("readStripeSubscription — a price it cannot place", () => {
  it("says the price is unknown rather than guessing an offer", () => {
    const read = readStripeSubscription(
      stripeSub({
        items: {
          data: [
            {
              id: "si_1",
              current_period_end: PERIOD_END,
              price: { id: "price_somebody_elses" },
            },
          ],
        },
      }),
      "u-1",
    );
    expect(read).toEqual({ ok: false, reason: "priceUnknown" });
  });

  it("says the same for a subscription carrying no item at all", () => {
    const read = readStripeSubscription(
      stripeSub({ items: { data: [] } }),
      "u-1",
    );
    expect(read).toEqual({ ok: false, reason: "priceUnknown" });
  });
});

describe("readStripeSubscription — a price that disagrees with ours", () => {
  // This is a different answer from "unknown", and the difference matters:
  // one caller reads "unknown" as "already applied" and would tell somebody
  // their change went through while the row still holds the old plan.

  it("reports both figures when Stripe charges a different amount", () => {
    const read = readStripeSubscription(
      stripeSub({ items: itemsSelling("price_pro_m", { unit_amount: 999 }) }),
      "u-1",
    );
    expect(read).toEqual({
      ok: false,
      reason: "priceDisagreement",
      expected: { cents: 1999, currency: "usd", interval: "month" },
      actual: { cents: 999, currency: "usd", interval: "month" },
    });
  });

  it("reports both when Stripe charges a different currency", () => {
    const read = readStripeSubscription(
      stripeSub({ items: itemsSelling("price_pro_m", { currency: "eur" }) }),
      "u-1",
    );
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toBe("priceDisagreement");
    expect(!read.ok && read.reason === "priceDisagreement" && read.actual.currency).toBe("eur");
  });

  it("reports both when Stripe bills over a different length of time", () => {
    // A price created as "every 12 months" charges the same as an yearly one
    // and is not the same price. The slot a price sits in here is what the
    // panel, the renewal date and the move rules all read.
    const read = readStripeSubscription(
      stripeSub({
        items: itemsSelling("price_pro_y", { recurring: { interval: "month" } }),
      }),
      "u-1",
    );
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason === "priceDisagreement" && read.actual.interval).toBe("month");
    expect(!read.ok && read.reason === "priceDisagreement" && read.expected.interval).toBe("year");
  });

  it("reports a price Stripe did not expand rather than passing it", () => {
    // An unexpanded price is a bare id string: there is no amount to compare,
    // and letting that through would hand out a tier nobody checked.
    const read = readStripeSubscription(
      stripeSub({
        items: {
          data: [
            {
              id: "si_1",
              current_period_end: PERIOD_END,
              price: "price_pro_m",
            },
          ],
        },
      }),
      "u-1",
    );
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason === "priceDisagreement" && read.actual.cents).toBeNull();
  });
});
