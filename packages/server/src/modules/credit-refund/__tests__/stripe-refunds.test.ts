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
const retrieve = vi.fn();
const getPaymentById = vi.fn();

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => ({ refunds: { list }, paymentIntents: { retrieve } }),
}));

vi.mock("@server/modules/payment/payment.repo.js", () => ({
  getPaymentById: (id: string) => getPaymentById(id),
}));

import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import {
  StripeReadError,
  listRefunds,
  listRefundsForPayment,
  readChargeDisputed,
  toRefundObject,
} from "@server/modules/credit-refund/stripe-refunds.js";

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
  retrieve.mockReset();
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
        pending_reason: null,
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

  it("carries Stripe's own text in its message, so a status row's last_error says why the read failed", () => {
    expect(new StripeReadError(forbidden()).message).toBe("Stripe refunds.list failed: synthetic 403");
  });
});

/**
 * `pending_reason` (v9 §5.1, §6.4): Stripe's own reason a refund is still
 * pending — processing, insufficient_funds or charge_pending. Any other
 * value is kept as processing (as an unknown status is kept as pending);
 * a refund that is not pending has none.
 */
describe("toRefundObject — pending_reason", () => {
  /**
   * A refund as stripe-node returns it.
   * @param status - Its status.
   * @param pendingReason - Its pending_reason.
   * @returns The refund.
   */
  const stripeRefund = (status: string, pendingReason: string | null) =>
    ({ ...REFUND, status, pending_reason: pendingReason }) as unknown as Stripe.Refund;

  it.each(["processing", "insufficient_funds", "charge_pending"])("a pending refund keeps pending_reason %s", (reason) => {
    expect(toRefundObject(stripeRefund("pending", reason)).pending_reason).toBe(reason);
  });

  it("a pending refund with a pending_reason Stripe may add later is stored as processing", () => {
    expect(toRefundObject(stripeRefund("pending", "some_future_reason")).pending_reason).toBe("processing");
  });

  it.each(["succeeded", "failed", "canceled", "requires_action"])(
    "a %s refund has no pending_reason, whatever Stripe left on it",
    (status) => {
      expect(toRefundObject(stripeRefund(status, "insufficient_funds")).pending_reason).toBeNull();
    },
  );
});

/**
 * `readChargeDisputed(paymentIntent)` (v9 §5.3): whether Stripe holds the
 * payment's charge as disputed, read with
 * `paymentIntents.retrieve(pi, { expand: ["latest_charge"] })`, bounded like
 * every other read of a disposition. A failed read is a StripeReadError (the
 * endpoint answers 503); a payment with no PaymentIntent has no charge on
 * Stripe and reads as not disputed.
 */
describe("readChargeDisputed", () => {
  it("retrieves the intent with its latest charge, bounded like listRefunds", async () => {
    retrieve.mockResolvedValue({ id: "pi_1", latest_charge: { id: "ch_1", disputed: false } });

    await readChargeDisputed("pi_1");

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0]![0]).toBe("pi_1");
    expect(retrieve.mock.calls[0]![1]).toEqual({ expand: ["latest_charge"] });
    expect(retrieve.mock.calls[0]![2]).toEqual({
      timeout: getCreditRefundConfig().stripeCallTimeoutMs,
      maxNetworkRetries: 0,
    });
  });

  it("answers true for a disputed charge", async () => {
    retrieve.mockResolvedValue({ id: "pi_1", latest_charge: { id: "ch_1", disputed: true } });
    expect(await readChargeDisputed("pi_1")).toBe(true);
  });

  it("answers false for an undisputed charge", async () => {
    retrieve.mockResolvedValue({ id: "pi_1", latest_charge: { id: "ch_1", disputed: false } });
    expect(await readChargeDisputed("pi_1")).toBe(false);
  });

  it("answers false when the intent has no charge", async () => {
    retrieve.mockResolvedValue({ id: "pi_1", latest_charge: null });
    expect(await readChargeDisputed("pi_1")).toBe(false);
  });

  it("answers false for a payment with no PaymentIntent, without reading Stripe", async () => {
    expect(await readChargeDisputed(null)).toBe(false);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("wraps a failed read as a StripeReadError carrying Stripe's failure", async () => {
    retrieve.mockRejectedValue(
      new Stripe.errors.StripeAPIError({ type: "api_error", message: "synthetic 500", statusCode: 500 }),
    );

    const err = await readChargeDisputed("pi_1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StripeReadError);
    expect((err as StripeReadError).failure).toEqual({ message: "synthetic 500", httpStatus: 500, type: "api_error" });
  });
});
