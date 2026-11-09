// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", () => ({
  accountOnlyConsent: vi.fn(),
  enqueueAdsConversion: vi.fn(async () => true),
  getSubscriptionPlan: () => ({ priceCents: 1999, currency: "usd", stripePriceId: "price_pro_month" }),
  logger: { error: vi.fn() },
  trackServerEvent: vi.fn(),
}));
vi.mock("@server/modules/analytics/checkout-snapshot.js", () => ({
  readCheckoutSnapshot: () => ({ consent: { analytics: true, ads: true }, click: null }),
}));

import { enqueueAdsConversion, trackServerEvent } from "@breatic/core";
import { reportSubscriptionStarted, subscriptionConversion } from "../subscription-analytics.js";

const write = {
  userId: "u-1",
  stripeSubscriptionId: "sub_1",
  status: "active",
  tier: "pro",
  period: "month",
} as Parameters<typeof reportSubscriptionStarted>[0];

describe("the first conversion's amount (inner#1868 §6)", () => {
  it("is the first invoice's amount when there is one", () => {
    expect(subscriptionConversion(write, 1599)).toEqual({ transactionId: "sub:sub_1", amountCents: 1599, currency: "usd" });
  });

  it("falls back to the price list when the first invoice's amount is unknown", () => {
    expect(subscriptionConversion(write, null)).toEqual({ transactionId: "sub:sub_1", amountCents: 1999, currency: "usd" });
  });

  it("reports the server-side start with the first invoice's amount, to analytics and ads alike", () => {
    reportSubscriptionStarted(write, null, 1599);
    expect(trackServerEvent).toHaveBeenCalledWith(
      "subscription_started",
      expect.objectContaining({ properties: expect.objectContaining({ amount_cents: 1599 }) }),
      expect.anything(),
    );
    expect(enqueueAdsConversion).toHaveBeenCalledWith(
      expect.objectContaining({ value: { amountCents: 1599, currency: "usd" } }),
      expect.anything(),
    );
  });
});
