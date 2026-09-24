// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the reconciliation does with a subscription it cannot price (#253 A14).
 *
 * Opening the panel rewrites the stored rows from Stripe, which is how a lost
 * event gets repaired. That makes it the one path where a disagreement
 * between our price list and what Stripe is actually charging would be
 * written in as the truth — and then read back as the tier in force.
 *
 * So the rule is: a row we cannot price is not written, and the disagreement
 * is logged with both figures. Skipping it silently would leave the same
 * account being repaired on every open with nothing anywhere saying why.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { upsertSubscription, logger, stripe } = vi.hoisted(() => ({
  upsertSubscription: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  stripe: { subscriptions: { list: vi.fn() } },
}));

vi.mock("@breatic/core", () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
  logger,
  upsertSubscription,
  listSubscriptions: vi.fn(async () => []),
  lockAccountRow: vi.fn(),
  subscriptionSituation: vi.fn(() => ({ situation: "none", record: null })),
  tierForSituation: vi.fn(() => "base"),
  getStripeCallTimeoutMs: () => 5000,
  getSubscriptionPlan: (tier: string, period: string) => ({
    priceCents: (tier === "pro" ? 1999 : 7999) * (period === "year" ? 10 : 1),
    currency: "usd",
    stripePriceId: `price_${tier}_${period}`,
  }),
  findOfferByPriceId: (priceId: string) => {
    const [, tier, period] = priceId.split("_");
    return tier && period ? { tier, period } : null;
  },
}));

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

vi.mock("@server/modules/auth/user.repo.js", () => ({
  getStripeCustomerId: vi.fn(async () => "cus_1"),
}));

vi.mock("@server/modules/subscription/settle-tier.js", () => ({
  settleTier: vi.fn(async () => ({ endedFrom: null })),
  sendMembershipEndedMail: vi.fn(),
}));

import { readSubscriptionSummary } from "@server/modules/subscription/subscription-panel.js";

const USER = "u-1";

/**
 * One subscription as Stripe returns it, priced however the case needs.
 * @param unitAmount - What Stripe says it charges, in cents.
 * @param priceId - Which price it is on.
 * @returns A Stripe subscription.
 */
function stripeSubscription(unitAmount: number, priceId = "price_pro_month"): unknown {
  return {
    id: "sub_1",
    status: "active",
    cancel_at_period_end: false,
    pending_update: null,
    latest_invoice: null,
    items: {
      data: [
        {
          id: "si_1",
          current_period_end: 1_789_000_000,
          price: {
            id: priceId,
            unit_amount: unitAmount,
            currency: "usd",
            recurring: { interval: "month" },
          },
        },
      ],
    },
  };
}

describe("reconciliation — a subscription we cannot price", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the row when Stripe charges what our list says", async () => {
    stripe.subscriptions.list.mockResolvedValue({
      data: [stripeSubscription(1999)],
    });

    await readSubscriptionSummary(USER);

    expect(upsertSubscription).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("writes nothing when Stripe charges a different amount, and says so", async () => {
    stripe.subscriptions.list.mockResolvedValue({
      data: [stripeSubscription(4999)],
    });

    await readSubscriptionSummary(USER);

    expect(upsertSubscription).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        stripeSubscriptionId: "sub_1",
        // Both figures, because the one thing an operator needs is which side
        // is wrong, and neither number alone answers that.
        expected: expect.objectContaining({ cents: 1999 }),
        actual: expect.objectContaining({ cents: 4999 }),
      }),
      "subscription_price_disagreement",
    );
  });

  it("writes nothing for a price we do not sell either", async () => {
    stripe.subscriptions.list.mockResolvedValue({
      data: [stripeSubscription(1999, "priceweknownothingabout")],
    });

    await readSubscriptionSummary(USER);

    expect(upsertSubscription).not.toHaveBeenCalled();
  });

  it("keeps the rows it can price when one of several disagrees", async () => {
    // One bad row must not cost the account the repair of its good ones.
    const good = stripeSubscription(1999) as Record<string, unknown>;
    const bad = stripeSubscription(4999) as Record<string, unknown>;
    bad.id = "sub_2";
    stripe.subscriptions.list.mockResolvedValue({ data: [good, bad] });

    await readSubscriptionSummary(USER);

    expect(upsertSubscription).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("reconciliation — whether the answer came from Stripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says it reconciled when Stripe answered", async () => {
    stripe.subscriptions.list.mockResolvedValue({ data: [] });

    const summary = await readSubscriptionSummary(USER);

    expect(summary.reconciled).toBe(true);
  });

  it("says it did not reconcile when the Stripe read failed", async () => {
    // The stored rows are still answered, because the rest of the panel does
    // not depend on Stripe. But a reader coming back from a checkout whose
    // webhook has not landed would read "no subscription" as "not bought",
    // and only this flag tells that apart from Stripe saying so.
    stripe.subscriptions.list.mockRejectedValue(new Error("stripe down"));

    const summary = await readSubscriptionSummary(USER);

    expect(summary.state).toBe("none");
    expect(summary.reconciled).toBe(false);
  });
});
