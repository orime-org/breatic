// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ findUser: vi.fn(), read: vi.fn(), subscriptions: vi.fn(), situation: vi.fn(), retrieve: vi.fn() }));
vi.mock("@breatic/core", () => ({ db: {}, findOfferByPriceId: vi.fn(), getStripeCallTimeoutMs: () => 2000, listSubscriptions: mocked.subscriptions, subscriptionClock: () => new Date(), subscriptionSituation: mocked.situation }));
vi.mock("@server/infra/stripe.js", () => ({ getStripeClient: () => ({ subscriptions: { retrieve: mocked.retrieve } }) }));
vi.mock("@server/modules/auth/user.repo.js", () => ({ findUserIdByStripeCustomerId: mocked.findUser }));
vi.mock("@server/modules/notification/notification.service.js", () => ({}));
vi.mock("@server/modules/subscription/read-stripe-subscription.js", () => ({ readStripeSubscription: mocked.read }));
vi.mock("@server/modules/subscription/apply-subscription.js", () => ({ applySubscriptionWrite: vi.fn() }));
vi.mock("@server/modules/subscription/webhook-events.repo.js", () => ({ claimWebhookEvent: vi.fn() }));
vi.mock("@server/modules/subscription/settle-tier.js", () => ({ sendMembershipEndedMail: vi.fn() }));
vi.mock("@server/modules/subscription/subscription-analytics.js", () => ({ reportSubscriptionRenewed: vi.fn(), reportSubscriptionStarted: vi.fn() }));
import { handleSubscriptionEvent } from "@server/modules/subscription/subscription-events.js";

/** Creates a membership event for the producer's early returns. */
function event(type: string): Stripe.Event {
  return { id: "evt_reason", type, data: { object: { id: "sub_reason", customer: "cus_reason", metadata: {}, billing_reason: "subscription_cycle" } } } as unknown as Stripe.Event;
}

beforeEach(() => { vi.clearAllMocks(); mocked.findUser.mockResolvedValue(null); });

describe("finite membership no-op reasons", () => {
  it("classifies an unidentified subscription account", async () => {
    expect(await handleSubscriptionEvent(event("customer.subscription.updated"))).toEqual({ status: "noop", reasonCode: "no_account", reason: "no account claims Stripe customer cus_reason" });
  });
  it("classifies the unknown configured price", async () => {
    mocked.findUser.mockResolvedValue("user_reason");
    mocked.retrieve.mockResolvedValue({});
    mocked.read.mockReturnValue({ ok: false, reason: "unknownPrice" });
    expect(await handleSubscriptionEvent(event("customer.subscription.updated"))).toEqual({ status: "noop", reasonCode: "unknown_price", reason: "subscription sub_reason sells a price this deployment does not know" });
  });
  it("classifies an unidentified renewal account", async () => {
    expect(await handleSubscriptionEvent(event("invoice.paid"))).toEqual({ status: "noop", reasonCode: "no_account", reason: "no account claims Stripe customer cus_reason" });
  });
  it("classifies a renewal without a local subscription", async () => {
    mocked.findUser.mockResolvedValue("user_reason");
    mocked.subscriptions.mockResolvedValue([]);
    mocked.situation.mockReturnValue({ record: null });
    expect(await handleSubscriptionEvent(event("invoice.paid"))).toEqual({ status: "noop", reasonCode: "no_subscription", reason: "account user_reason holds no subscription" });
  });
});
