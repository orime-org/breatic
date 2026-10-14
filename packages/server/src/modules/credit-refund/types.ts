// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared shapes of the credit-pack refund disposition (inner#1410).
 */

/** A Stripe refund's status, verbatim. */
export type StripeRefundStatus =
  | "pending"
  | "requires_action"
  | "succeeded"
  | "failed"
  | "canceled";

/** Why Stripe holds a refund as pending (§5.1). */
export type StripePendingReason = "processing" | "insufficient_funds" | "charge_pending";

/** A Stripe refund object, with the fields the product reads. */
export interface StripeRefundObject {
  id: string;
  amount: number;
  currency: string;
  status: StripeRefundStatus;
  failure_reason?: string | null;
  /** Why it is still pending; null in every other status (§5.1). */
  pending_reason?: StripePendingReason | null;
  metadata?: Record<string, string> | null;
}

/**
 * The product's copy of one Stripe refund (`credit_refunds`), in the column
 * names the rules read. `operationId` is null for a refund made outside the
 * product.
 */
export interface RefundCopy {
  stripeRefundId: string;
  amountCents: number;
  status: StripeRefundStatus;
  pendingReason: StripePendingReason | null;
  operationId: string | null;
  everSucceeded: boolean;
  resolvedByOperationId: string | null;
  failureReason: string | null;
}
