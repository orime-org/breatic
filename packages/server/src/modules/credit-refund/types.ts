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

/** A Stripe refund object, with the fields the product reads. */
export interface StripeRefundObject {
  id: string;
  amount: number;
  currency: string;
  status: StripeRefundStatus;
  failure_reason?: string | null;
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
  operationId: string | null;
  everSucceeded: boolean;
  resolvedByOperationId: string | null;
  failureReason: string | null;
}
