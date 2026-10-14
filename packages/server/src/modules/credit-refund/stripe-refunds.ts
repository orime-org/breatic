// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three Stripe calls of the refund disposition: `refunds.list` and
 * `refunds.create` (inner#1410 §5.2), and `paymentIntents.retrieve` for the
 * charge's `disputed` (§5.3); and how their answers become the shapes the
 * rules read.
 */

import Stripe from "stripe";
import { getStripeClient } from "@server/infra/stripe.js";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import type { StripeFailure } from "@server/modules/credit-refund/operation-transitions.js";
import type { CreateAnswer } from "@server/modules/credit-refund/stripe-answer.js";
import type {
  StripePendingReason,
  StripeRefundObject,
  StripeRefundStatus,
} from "@server/modules/credit-refund/types.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";

/** `autoPagingToArray` requires a ceiling; no payment has anywhere near this many refunds. */
const MAX_REFUNDS = 10_000;

const STATUSES: ReadonlySet<string> = new Set<StripeRefundStatus>([
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
]);

const PENDING_REASONS: ReadonlySet<string> = new Set<StripePendingReason>([
  "processing",
  "insufficient_funds",
  "charge_pending",
]);

/** A Stripe read (`refunds.list` or `paymentIntents.retrieve`) failed; nothing was read. */
export class StripeReadError extends Error {
  declare readonly failure: StripeFailure;

  /**
   * Wrap the read's error.
   * @param err - What the read threw.
   * @param call - Which Stripe call failed.
   */
  constructor(err: unknown, call: "refunds.list" | "paymentIntents.retrieve" = "refunds.list") {
    const failure = toFailure(err);
    super(`Stripe ${call} failed: ${failure.message}`, { cause: err });
    this.name = "StripeReadError";
    // Not enumerable: pino's err serializer would copy it and rename Stripe's
    // error type to "Object"; log lines carry it under `failure` instead.
    Object.defineProperty(this, "failure", { value: failure, enumerable: false });
  }
}

/**
 * A Stripe refund in the shape the rules read. A status outside Stripe's
 * documented five is read as `pending`: not an outcome, so nothing is
 * booked on it. A pending refund's reason outside the documented three is
 * read as `processing` for the same reason (§5.1); every other status has no
 * pending reason.
 * @param r - The refund as stripe-node returns it.
 * @returns The refund object.
 */
export function toRefundObject(r: Stripe.Refund): StripeRefundObject {
  const status: StripeRefundStatus = STATUSES.has(r.status ?? "") ? (r.status as StripeRefundStatus) : "pending";
  const reason = r.pending_reason ?? null;
  return {
    id: r.id,
    amount: r.amount,
    currency: r.currency,
    status,
    failure_reason: r.failure_reason ?? null,
    pending_reason:
      status !== "pending" ? null : PENDING_REASONS.has(reason ?? "") ? reason : "processing",
    metadata: r.metadata ?? {},
  };
}

/**
 * Every refund Stripe holds for a payment intent, all pages.
 * @param paymentIntent - `pi_…`.
 * @returns The refunds.
 * @throws {StripeReadError} When the read fails.
 */
export async function listRefunds(paymentIntent: string): Promise<StripeRefundObject[]> {
  try {
    const refunds = await getStripeClient()
      .refunds.list({ payment_intent: paymentIntent, limit: 100 }, callOptions())
      .autoPagingToArray({ limit: MAX_REFUNDS });
    return refunds.map(toRefundObject);
  } catch (err) {
    throw new StripeReadError(err);
  }
}

/**
 * Every refund Stripe holds for a payment. A payment with no payment intent
 * has none: nothing on Stripe can refund it.
 * @param paymentId - The payment.
 * @returns The refunds.
 * @throws {Error} When the payment does not exist.
 * @throws {StripeReadError} When the read fails.
 */
export async function listRefundsForPayment(paymentId: string): Promise<StripeRefundObject[]> {
  const payment = await paymentRepo.getPaymentById(paymentId);
  if (!payment) throw new Error(`payment ${paymentId} does not exist`);
  return payment.stripePaymentIntentId ? listRefunds(payment.stripePaymentIntentId) : [];
}

/**
 * Whether Stripe holds the payment's charge as disputed (§5.3): the latest
 * charge's `disputed`. A payment with no payment intent, or an intent with no
 * charge, has nothing to dispute.
 * @param paymentIntent - `pi_…`, or null when the payment has none.
 * @returns True when the charge is disputed.
 * @throws {StripeReadError} When the read fails.
 */
export async function readChargeDisputed(paymentIntent: string | null): Promise<boolean> {
  if (paymentIntent === null) return false;
  try {
    const intent = await getStripeClient().paymentIntents.retrieve(
      paymentIntent,
      { expand: ["latest_charge"] },
      callOptions(),
    );
    const charge = intent.latest_charge;
    return typeof charge === "object" && charge !== null && charge.disputed === true;
  } catch (err) {
    throw new StripeReadError(err, "paymentIntents.retrieve");
  }
}

/**
 * The options every Stripe call of a disposition runs with: its own timeout
 * and no retries, so an attempt fits inside its lease (§7.4).
 * @returns The request options.
 */
function callOptions(): { timeout: number; maxNetworkRetries: 0 } {
  return { timeout: getCreditRefundConfig().stripeCallTimeoutMs, maxNetworkRetries: 0 };
}

/**
 * Ask Stripe for a disposition's refund under its own idempotency key. No
 * amount is sent: Stripe refunds what is left of the payment (§5.2).
 * @param input - The disposition and what to refund.
 * @param input.operationId - The disposition; names the key and the metadata.
 * @param input.paymentIntent - The payment intent to refund.
 * @returns The classified answer, with the refund object or the failure behind it.
 */
export async function createRefund(input: {
  operationId: string;
  paymentIntent: string;
}): Promise<{ answer: CreateAnswer; refund?: StripeRefundObject; failure?: StripeFailure }> {
  try {
    const created = await getStripeClient().refunds.create(
      {
        payment_intent: input.paymentIntent,
        metadata: { refund_operation_id: input.operationId },
      },
      { idempotencyKey: `credit-refund-${input.operationId}`, ...callOptions() },
    );
    return { answer: { kind: "refund" }, refund: toRefundObject(created) };
  } catch (err) {
    return { answer: toCreateAnswer(err), failure: toFailure(err) };
  }
}

/**
 * What a failed create call came back with, for §5.4.
 * @param err - What stripe-node threw.
 * @returns The answer.
 */
function toCreateAnswer(err: unknown): CreateAnswer {
  // stripe-node reports a timeout and a dropped connection alike.
  if (err instanceof Stripe.errors.StripeConnectionError) return { kind: "network" };
  if (err instanceof Stripe.errors.StripeError && typeof err.statusCode === "number") {
    return {
      kind: "stripe_error",
      httpStatus: err.statusCode,
      type: err.rawType,
      code: err.code,
      shouldRetry: shouldRetryOf(err.headers),
    };
  }
  return { kind: "other_error" };
}

/**
 * The fields of a Stripe failure kept in the event row.
 * @param err - What was thrown.
 * @returns The failure.
 */
export function toFailure(err: unknown): StripeFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof Stripe.errors.StripeError)) return { message };
  const shouldRetry = shouldRetryOf(err.headers);
  return {
    message,
    ...(err.statusCode !== undefined && { httpStatus: err.statusCode }),
    ...(err.rawType !== undefined && { type: err.rawType }),
    ...(err.code !== undefined && { code: err.code }),
    ...(shouldRetry !== undefined && { shouldRetry }),
  };
}

/**
 * The `Stripe-Should-Retry` header.
 * @param headers - The response headers stripe-node kept.
 * @returns Its value, or undefined when not sent.
 */
function shouldRetryOf(headers: Record<string, string> | undefined): boolean | undefined {
  const value = headers?.["stripe-should-retry"];
  return value === "true" ? true : value === "false" ? false : undefined;
}
