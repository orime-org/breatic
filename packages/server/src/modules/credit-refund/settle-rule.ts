// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a succeeded refund may be booked (inner#1410 §5.4) — and the narrower
 * rule a refund_again disposition uses (§5.2).
 */

import type { RefundCopy, StripeRefundStatus } from "@server/modules/credit-refund/types.js";

/** The verdict on whether an approval or retry can be booked now. */
export type SettleVerdict =
  | { outcome: "settle"; succeededCents: number }
  | { outcome: "wait" }
  | { outcome: "attention"; reason: "partial_refund" | "unexpected_external_refund" };

/**
 * The three settle conditions, in order: nothing still in flight; the
 * succeeded sum reaches what was paid; every succeeded refund made outside
 * the product is one the operator confirmed.
 * @param input - Every refund of the payment, the paid amount, and the
 *   external refunds the operator confirmed.
 * @param input.refunds - The payment's refund copies.
 * @param input.paidCents - What the buyer paid, tax included.
 * @param input.confirmedRefundIds - External refunds shown on the confirm page.
 * @returns The verdict.
 */
export function canSettle(input: {
  refunds: readonly RefundCopy[];
  paidCents: number;
  confirmedRefundIds: readonly string[];
}): SettleVerdict {
  if (input.refunds.some((r) => r.status === "pending" || r.status === "requires_action")) {
    return { outcome: "wait" };
  }
  const succeeded = input.refunds.filter((r) => r.status === "succeeded");
  const succeededCents = succeeded.reduce((sum, r) => sum + r.amountCents, 0);
  if (succeededCents < input.paidCents) return { outcome: "attention", reason: "partial_refund" };
  const confirmed = new Set(input.confirmedRefundIds);
  if (succeeded.some((r) => r.operationId === null && !confirmed.has(r.stripeRefundId))) {
    return { outcome: "attention", reason: "unexpected_external_refund" };
  }
  return { outcome: "settle", succeededCents };
}

/**
 * refund_again settles on its own refund alone: it asks Stripe for exactly the
 * failed refunds' amount, so the payment's other refunds do not decide it.
 * @param status - Its own refund's status.
 * @returns Whether it can finish now.
 */
export function refundAgainOutcome(status: StripeRefundStatus): "settle" | "wait" | "attention" {
  if (status === "succeeded") return "settle";
  if (status === "pending" || status === "requires_action") return "wait";
  return "attention";
}
