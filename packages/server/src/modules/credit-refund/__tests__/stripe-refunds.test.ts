// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `refunds.list` read of the refund disposition (inner#1410 §7.4, §7.2).
 *
 * The read runs inside the same lease as the create, so it is bounded the
 * same way: `stripe_call_timeout_ms` and no network retries. With
 * stripe-node's defaults (80 s, two retries, per page) a slow Stripe would
 * outlive the lease, and a second instance would claim the disposition while
 * the first still waits.
 *
 * `listRefundsForPayment(paymentId)` is the one place that decides what a
 * payment with no payment intent reads as: no refunds, because nothing can
 * have been refunded through Stripe without one.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const list = vi.fn();
const getPaymentById = vi.fn();

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => ({ refunds: { list } }),
}));

vi.mock("@server/modules/payment/payment.repo.js", () => ({
  getPaymentById: (id: string) => getPaymentById(id),
}));

import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { listRefunds, listRefundsForPayment } from "@server/modules/credit-refund/stripe-refunds.js";

/** One refund as stripe-node hands it back. */
const REFUND = {
  id: "re_1",
  object: "refund",
  amount: 1080,
  currency: "usd",
  status: "succeeded",
  failure_reason: null,
  metadata: { refund_operation_id: "op_1" },
};

/**
 * What `refunds.list(...)` returns: a list promise that auto-pages.
 * @param data - The refunds on it.
 * @returns The list promise.
 */
function listAnswer(data: unknown[]): Promise<unknown> {
  return Object.assign(Promise.resolve({ object: "list", data, has_more: false }), {
    autoPagingToArray: async () => data,
  });
}

beforeEach(() => {
  list.mockReset();
  getPaymentById.mockReset();
  list.mockImplementation(() => listAnswer([REFUND]));
});

describe("listRefunds — bounded like the create call", () => {
  it("passes { timeout: stripe_call_timeout_ms, maxNetworkRetries: 0 } as request options", async () => {
    await listRefunds("pi_1");

    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]![0]).toMatchObject({ payment_intent: "pi_1" });
    expect(list.mock.calls[0]![1]).toEqual({
      timeout: getCreditRefundConfig().stripeCallTimeoutMs,
      maxNetworkRetries: 0,
    });
  });
});

describe("listRefundsForPayment — one rule for a payment without an intent", () => {
  it("answers [] for a payment with no stripe_payment_intent_id, without reading Stripe", async () => {
    getPaymentById.mockResolvedValue({ id: "pay_1", stripePaymentIntentId: null });

    expect(await listRefundsForPayment("pay_1")).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("otherwise lists the intent's refunds, bounded like listRefunds", async () => {
    getPaymentById.mockResolvedValue({ id: "pay_2", stripePaymentIntentId: "pi_2" });

    expect(await listRefundsForPayment("pay_2")).toEqual([
      {
        id: "re_1",
        amount: 1080,
        currency: "usd",
        status: "succeeded",
        failure_reason: null,
        metadata: { refund_operation_id: "op_1" },
      },
    ]);
    expect(getPaymentById).toHaveBeenCalledWith("pay_2");
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]![0]).toMatchObject({ payment_intent: "pi_2" });
    expect(list.mock.calls[0]![1]).toEqual({
      timeout: getCreditRefundConfig().stripeCallTimeoutMs,
      maxNetworkRetries: 0,
    });
  });
});
