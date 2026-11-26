// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", () => ({
  enqueueAdsConversion: vi.fn(async () => true),
  logger: { error: vi.fn() },
  trackServerEvent: vi.fn(),
}));

import { enqueueAdsConversion, trackServerEvent } from "@breatic/core";
import { reportSubscriptionStarted } from "../subscription-analytics.js";

describe("reportSubscriptionStarted", () => {
  it("reports the start the billing service sent, to analytics and ads alike", () => {
    reportSubscriptionStarted("u-1", {
      properties: { tier: "pro", interval: "month", amountCents: 1599, currency: "usd" },
      consent: { analytics: true, ads: true },
      click: null,
      transactionId: "sub:sub_1",
    });

    expect(trackServerEvent).toHaveBeenCalledWith(
      "subscription_started",
      { userId: "u-1", insertId: "sub:sub_1", properties: { tier: "pro", interval: "month", amount_cents: 1599, currency: "usd" } },
      { analytics: true, ads: true },
    );
    expect(enqueueAdsConversion).toHaveBeenCalledWith(
      { userId: "u-1", conversion: "subscription", transactionId: "sub:sub_1", click: null, value: { amountCents: 1599, currency: "usd" } },
      { consent: true },
    );
  });
});
