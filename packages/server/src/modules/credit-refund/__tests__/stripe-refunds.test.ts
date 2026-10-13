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

import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { describe, it, expect, beforeEach, vi } from "vitest";
import Stripe from "stripe";

const list = vi.fn();
const getPaymentById = vi.fn();

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => ({ refunds: { list } }),
}));

vi.mock("@server/modules/payment/payment.repo.js", () => ({
  getPaymentById: (id: string) => getPaymentById(id),
}));

import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { StripeReadError, listRefunds, listRefundsForPayment } from "@server/modules/credit-refund/stripe-refunds.js";

/** The slice of a pino logger this suite calls. */
type PinoFactory = (opts: object, stream: Writable) => { error: (obj: object, msg: string) => void };

/** The product's own pino, resolved from `@breatic/core`, which depends on it. */
const pino = createRequire(new URL("../../../../../core/package.json", import.meta.url))("pino") as PinoFactory;

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

describe("StripeReadError — logged under pino's err key (round 10 [3][7])", () => {
  /**
   * What a real pino instance, with the default serializers the product
   * logger keeps, writes for one error line.
   * @param obj - The merge object.
   * @returns The line, parsed.
   */
  function logLine(obj: object): Record<string, unknown> {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    pino({}, sink).error(obj, "refund_read_failed");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  /** A 403 as stripe-node builds it from Stripe's answer. */
  function forbidden(): Error {
    return new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message: "synthetic 403",
      statusCode: 403,
    });
  }

  it("serializes err as the error alone: no second copy of failure, whose type the serializer would turn into 'Object'", () => {
    const line = logLine({ err: new StripeReadError(forbidden()) });

    const err = line.err as Record<string, unknown>;
    expect(err.type).toBe("StripeReadError");
    expect(err).not.toHaveProperty("failure");
  });

  it("still carries Stripe's failure, with Stripe's own type, for code to read", () => {
    const err = new StripeReadError(forbidden());

    expect(err.failure).toEqual({ message: "synthetic 403", httpStatus: 403, type: "invalid_request_error" });
  });
});
