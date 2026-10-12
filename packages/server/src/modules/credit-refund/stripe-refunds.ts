// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two Stripe calls of the refund disposition (inner#1410 §5.2), and how
 * their answers become the shapes the rules read.
 */

import Stripe from "stripe";
import { getStripeClient } from "@server/infra/stripe.js";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import type { StripeFailure } from "@server/modules/credit-refund/operation-transitions.js";
import type { CreateAnswer } from "@server/modules/credit-refund/stripe-answer.js";
import type { StripeRefundObject, StripeRefundStatus } from "@server/modules/credit-refund/types.js";
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

/** `refunds.list` failed; nothing was read. */
export class StripeReadError extends Error {
  readonly failure: StripeFailure;

  /**
   * Wrap the read's error.
   * @param err - What the read threw.
   */
  constructor(err: unknown) {
    super("Stripe refunds.list failed", { cause: err });
    this.name = "StripeReadError";
    this.failure = toFailure(err);
  }
}

/**
 * A Stripe refund in the shape the rules read. A status outside Stripe's
 * documented five is read as `pending`: not an outcome, so nothing is
 * booked on it.
 * @param r - The refund as stripe-node returns it.
 * @returns The refund object.
 */
export function toRefundObject(r: Stripe.Refund): StripeRefundObject {
  return {
    id: r.id,
    amount: r.amount,
    currency: r.currency,
    status: STATUSES.has(r.status ?? "") ? (r.status as StripeRefundStatus) : "pending",
    failure_reason: r.failure_reason ?? null,
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
 * The options every Stripe call of a disposition runs with: its own timeout
 * and no retries, so an attempt fits inside its lease (§7.4).
 * @returns The request options.
 */
function callOptions(): { timeout: number; maxNetworkRetries: 0 } {
  return { timeout: getCreditRefundConfig().stripeCallTimeoutMs, maxNetworkRetries: 0 };
}

/**
 * Ask Stripe for a disposition's refund under its own idempotency key.
 * @param input - The disposition and what to refund.
 * @param input.operationId - The disposition; names the key and the metadata.
 * @param input.paymentIntent - The payment intent to refund.
 * @param input.amountCents - The exact amount (refund_again), or null for what is left.
 * @returns The classified answer, with the refund object or the failure behind it.
 */
export async function createRefund(input: {
  operationId: string;
  paymentIntent: string;
  amountCents: number | null;
}): Promise<{ answer: CreateAnswer; refund?: StripeRefundObject; failure?: StripeFailure }> {
  try {
    const created = await getStripeClient().refunds.create(
      {
        payment_intent: input.paymentIntent,
        ...(input.amountCents !== null && { amount: input.amountCents }),
        metadata: { refund_operation_id: input.operationId },
      },
      { idempotencyKey: `credit-refund-${input.operationId}`, ...callOptions() },
    );
    const refund = toRefundObject(created);
    return { answer: { kind: "refund", refund: { id: refund.id, status: refund.status } }, refund };
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
