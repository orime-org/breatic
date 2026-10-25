// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ membership: vi.fn(), fulfill: vi.fn(), failed: vi.fn(), refund: vi.fn() }));
vi.mock("@breatic/core", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@server/modules/subscription/subscription-events.js", () => ({ handleSubscriptionEvent: mocked.membership }));
vi.mock("@server/modules/payment/payment.service.js", () => ({ fulfillPayment: mocked.fulfill, handlePaymentFailed: mocked.failed }));
vi.mock("@server/modules/credit-refund/refund-webhook.js", () => ({ REFUND_EVENT_TYPES: new Set(["refund.created", "refund.updated", "refund.failed"]), handleRefundEvent: mocked.refund }));

import { dispatchStripeWebhook } from "@server/modules/stripe-webhook/dispatch.service.js";

/** Constructs the signed event shape the dispatcher receives. */
function event(type: string): Stripe.Event {
  return { id: "evt_dispatch", type, livemode: false, data: { object: { id: "cs_dispatch" } } } as unknown as Stripe.Event;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.membership.mockResolvedValue({ status: "notMine" });
});

describe("Stripe processing result classification", () => {
  it.each([
    ["granted", "credits_granted"], ["replay", "credits_replay"], ["noop", "credits_noop"], ["expired", "credits_expired"],
    ["failed", "credits_payment_failed"], ["mismatch", "credits_mismatch"], ["unknown", "credits_unknown"],
  ])("classifies credit outcome %s with the existing HTTP 200", async (status, result) => {
    mocked.fulfill.mockResolvedValue({ status });
    expect(await dispatchStripeWebhook(event("checkout.session.completed"))).toEqual({ result, responseStatus: 200, received: true });
    expect(mocked.fulfill).toHaveBeenCalledWith("cs_dispatch", { id: "evt_dispatch", type: "checkout.session.completed" });
  });

  it.each(["checkout.session.async_payment_succeeded", "checkout.session.expired"])("preserves the actual event type for %s", async type => {
    mocked.fulfill.mockResolvedValue({ status: "replay" });
    await dispatchStripeWebhook(event(type));
    expect(mocked.fulfill).toHaveBeenCalledWith("cs_dispatch", { id: "evt_dispatch", type });
  });

  it("routes asynchronous payment failure without an event claim input", async () => {
    mocked.failed.mockResolvedValue({ status: "failed" });
    expect(await dispatchStripeWebhook(event("checkout.session.async_payment_failed"))).toEqual({ result: "credits_payment_failed", responseStatus: 200, received: true });
    expect(mocked.failed).toHaveBeenCalledWith("cs_dispatch");
    expect(mocked.fulfill).toHaveBeenCalledTimes(0);
  });

  it.each([
    [{ status: "applied", userId: "u", tier: "pro" }, "membership_applied", 200],
    [{ status: "replay", userId: "u" }, "membership_replay", 200],
    [{ status: "acknowledged", reason: "controlled" }, "membership_acknowledged", 200],
    [{ status: "noop", reasonCode: "no_account", reason: "controlled" }, "membership_no_account", 200],
    [{ status: "noop", reasonCode: "unknown_price", reason: "controlled" }, "membership_unknown_price", 200],
    [{ status: "noop", reasonCode: "no_subscription", reason: "controlled" }, "membership_no_subscription", 200],
    [{ status: "priceDisagreement", expected: {}, actual: {} }, "membership_price_disagreement", 500],
  ])("classifies the membership outcome %j", async (outcome, result, responseStatus) => {
    mocked.membership.mockResolvedValue(outcome);
    expect(await dispatchStripeWebhook(event("customer.subscription.updated"))).toEqual({ result, responseStatus, received: responseStatus === 200 });
    expect(mocked.fulfill).toHaveBeenCalledTimes(0);
    expect(mocked.refund).toHaveBeenCalledTimes(0);
  });

  it.each([["synced", "refund_synced", 200], ["no_target", "refund_no_target", 200], ["unreadable", "refund_unreadable", 500]])("classifies refund result %s without changing its original type", async (outcome, result, responseStatus) => {
    mocked.refund.mockResolvedValue(outcome);
    const input = event("refund.failed");
    expect(await dispatchStripeWebhook(input)).toEqual({ result, responseStatus, received: responseStatus === 200 });
    expect(mocked.refund).toHaveBeenCalledWith(input);
  });

  it("confirms an ignored event without calling any credit handler", async () => {
    expect(await dispatchStripeWebhook(event("charge.updated"))).toEqual({ result: "ignored", responseStatus: 200, received: true });
    expect(mocked.fulfill).toHaveBeenCalledTimes(0);
    expect(mocked.failed).toHaveBeenCalledTimes(0);
  });

  it("preserves a business exception for the HTTP error handler", async () => {
    const failure = new Error("controlled business failure");
    mocked.membership.mockRejectedValue(failure);
    await expect(dispatchStripeWebhook(event("customer.subscription.updated"))).rejects.toBe(failure);
  });
});
