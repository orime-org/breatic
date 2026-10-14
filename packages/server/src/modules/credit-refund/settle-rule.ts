// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a succeeded refund may be booked (inner#1410 §5.4), and the succeeded
 * sum of a payment's refund copies every rule reads.
 */

import type { RefundCopy } from "@server/modules/credit-refund/types.js";

/** The verdict on whether an approval or retry can be booked now. */
export type SettleVerdict =
  | { outcome: "settle"; succeededCents: number }
  | { outcome: "wait" }
  | { outcome: "attention"; reason: "partial_refund" | "unexpected_external_refund" };

/**
 * What the payment's succeeded refunds add up to.
 * @param refunds - The payment's refund copies.
 * @returns The sum in cents.
 */
export function succeededCents(refunds: readonly Pick<RefundCopy, "status" | "amountCents">[]): number {
  return refunds.reduce((sum, r) => (r.status === "succeeded" ? sum + r.amountCents : sum), 0);
}

/**
 * Whether Stripe has not decided one of the payment's refunds yet.
 * @param refunds - The payment's refund copies.
 * @returns True when one is `pending` or `requires_action`.
 */
export function refundInProgress(refunds: readonly Pick<RefundCopy, "status">[]): boolean {
  return refunds.some((r) => r.status === "pending" || r.status === "requires_action");
}

/**
 * Whether a refund made outside the product succeeded without the operator
 * having confirmed it on the confirmation page.
 * @param refunds - The payment's refund copies.
 * @param confirmedRefundIds - The external refunds the operator confirmed.
 * @returns True when one is unconfirmed.
 */
export function hasUnconfirmedExternal(
  refunds: readonly RefundCopy[],
  confirmedRefundIds: readonly string[],
): boolean {
  const confirmed = new Set(confirmedRefundIds);
  return refunds.some(
    (r) => r.status === "succeeded" && r.operationId === null && !confirmed.has(r.stripeRefundId),
  );
}

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
  if (refundInProgress(input.refunds)) return { outcome: "wait" };
  const succeeded = succeededCents(input.refunds);
  if (succeeded < input.paidCents) return { outcome: "attention", reason: "partial_refund" };
  if (hasUnconfirmedExternal(input.refunds, input.confirmedRefundIds)) {
    return { outcome: "attention", reason: "unexpected_external_refund" };
  }
  return { outcome: "settle", succeededCents: succeeded };
}
