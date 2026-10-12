// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The judgement table shared by the preview and the three endpoints that
 * create a Stripe refund: approve, retry and refund_again (inner#1410 §5.2).
 *
 * Rows are read top to bottom and the first match answers. The preview reads
 * the same rows without what the confirmation page sends back, so the page
 * never shows "will refund" for a request the endpoint would then refuse.
 */

import type { CreditLotLifecycle } from "@breatic/shared";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";
import { pickUnresolvedFailedRefunds } from "@server/modules/credit-refund/unresolved.js";

/** The three dispositions that create a Stripe refund. */
export type RefundCreateKind = "approve" | "retry" | "refund_again";

/** What the table needs to know about one earlier disposition of the lot. */
export interface AssessOperation {
  status: "started" | "awaiting_stripe" | "succeeded" | "needs_attention";
  attentionClosedAt: Date | null;
  createdAt: Date;
}

/** The facts the table reads, as one endpoint receives them. */
export interface AssessInput {
  kind: RefundCreateKind;
  lot: { lifecycle: CreditLotLifecycle; remainingCredits: number; ledgerSum: number };
  payment: { status: string; stripePaymentIntentId: string | null; paidCents: number } | null;
  ops: readonly AssessOperation[];
  refunds: readonly RefundCopy[];
  confirmedRefundIds: readonly string[];
  failedRefundIds: readonly string[];
}

/** Why Stripe's current state stops the refund. */
export type StripeBlockReason =
  | "failed_refunds_changed"
  | "refund_in_progress"
  | "already_refunded"
  | "unconfirmed_external_refund";

/** The table's answer. */
export type AssessResult =
  | { outcome: "create_refund"; amountCents: number; sendAmount: boolean }
  | { outcome: "blocked"; code: "lot_state_changed" | "operation_in_progress" }
  | { outcome: "blocked"; code: "stripe_blocks"; reason: StripeBlockReason };

/** The lot state each kind starts from. */
const REQUIRED_LIFECYCLE: Record<RefundCreateKind, CreditLotLifecycle> = {
  approve: "refund_pending",
  retry: "refunding",
  refund_again: "refunded",
};

const LOT_STATE_CHANGED: AssessResult = { outcome: "blocked", code: "lot_state_changed" };

/**
 * A blocked answer naming Stripe's state.
 * @param reason - Which part of Stripe's state stops it.
 * @returns The answer.
 */
function stripeBlocks(reason: StripeBlockReason): AssessResult {
  return { outcome: "blocked", code: "stripe_blocks", reason };
}

/**
 * Run the table. `fromPreview` skips the two rows that compare against what
 * the confirmation page sends back.
 * @param input - The facts.
 * @param fromPreview - True when no confirmation has been made yet.
 * @returns The answer.
 */
function judge(input: AssessInput, fromPreview: boolean): AssessResult {
  const { kind, lot, payment, ops, refunds } = input;
  if (lot.lifecycle !== REQUIRED_LIFECYCLE[kind] || payment === null) return LOT_STATE_CHANGED;
  if (
    kind === "approve" &&
    (payment.status !== "completed" ||
      payment.stripePaymentIntentId === null ||
      lot.remainingCredits !== lot.ledgerSum)
  ) {
    return LOT_STATE_CHANGED;
  }
  if (ops.some((o) => o.status === "started" || o.status === "awaiting_stripe")) {
    return { outcome: "blocked", code: "operation_in_progress" };
  }

  const unresolved = pickUnresolvedFailedRefunds(lot.lifecycle, refunds);
  if (kind === "retry" && !latestIsOpenAttention(ops)) return LOT_STATE_CHANGED;
  if (kind === "refund_again") {
    if (unresolved.length === 0) return LOT_STATE_CHANGED;
    if (!fromPreview && !sameIds(input.failedRefundIds, unresolved)) {
      return stripeBlocks("failed_refunds_changed");
    }
  }
  if (refunds.some((r) => r.status === "pending" || r.status === "requires_action")) {
    return stripeBlocks("refund_in_progress");
  }
  if (kind === "refund_again") {
    const amountCents = unresolved.reduce((sum, r) => sum + r.amountCents, 0);
    return { outcome: "create_refund", amountCents, sendAmount: true };
  }

  const succeeded = refunds.filter((r) => r.status === "succeeded");
  const succeededCents = succeeded.reduce((sum, r) => sum + r.amountCents, 0);
  if (succeededCents >= payment.paidCents) return stripeBlocks("already_refunded");
  if (!fromPreview) {
    const confirmed = new Set(input.confirmedRefundIds);
    if (succeeded.some((r) => r.operationId === null && !confirmed.has(r.stripeRefundId))) {
      return stripeBlocks("unconfirmed_external_refund");
    }
  }
  return { outcome: "create_refund", amountCents: payment.paidCents - succeededCents, sendAmount: false };
}

/**
 * Whether the lot's latest disposition is a needs_attention nobody closed.
 * @param ops - The lot's dispositions, in any order.
 * @returns True when a retry may start.
 */
function latestIsOpenAttention(ops: readonly AssessOperation[]): boolean {
  let latest: AssessOperation | null = null;
  for (const o of ops) if (!latest || o.createdAt > latest.createdAt) latest = o;
  return latest?.status === "needs_attention" && latest.attentionClosedAt === null;
}

/**
 * Whether the named ids are exactly the given refunds, in any order.
 * @param ids - What the request named.
 * @param refunds - What is current.
 * @returns True when the two sets are equal.
 */
function sameIds(ids: readonly string[], refunds: readonly RefundCopy[]): boolean {
  const named = new Set(ids);
  return named.size === refunds.length && refunds.every((r) => named.has(r.stripeRefundId));
}

/**
 * Judge a request to create a refund, as one of the three endpoints receives it.
 * @param input - The facts and what the confirmation page sent back.
 * @returns The answer.
 */
export function assessRefundCreate(input: AssessInput): AssessResult {
  return judge(input, false);
}

/**
 * The operation the preview judges for a lot in this state.
 * @param lifecycle - The lot's lifecycle.
 * @returns The kind, or null when the lot is not in the refund flow.
 */
export function previewKind(lifecycle: CreditLotLifecycle): RefundCreateKind | null {
  switch (lifecycle) {
    case "refund_pending":
      return "approve";
    case "refunding":
      return "retry";
    case "refunded":
      return "refund_again";
    default:
      return null;
  }
}

/**
 * What the confirmation page shows: the operation the lot's state allows and
 * what it would do now.
 * @param input - The facts, without any confirmation.
 * @param input.lot - The lot.
 * @param input.payment - The payment behind it.
 * @param input.ops - The lot's dispositions.
 * @param input.refunds - The payment's refund copies.
 * @returns The kind and its answer, or no kind.
 */
export function assessRefundPreview(input: {
  lot: AssessInput["lot"];
  payment: AssessInput["payment"];
  ops: readonly AssessOperation[];
  refunds: readonly RefundCopy[];
}): { kind: RefundCreateKind; result: AssessResult } | { kind: null } {
  const kind = previewKind(input.lot.lifecycle);
  if (kind === null) return { kind: null };
  const result = judge({ ...input, kind, confirmedRefundIds: [], failedRefundIds: [] }, true);
  return { kind, result };
}
