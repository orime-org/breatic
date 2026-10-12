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
import { failedCents, refundInProgress, succeededCents } from "@server/modules/credit-refund/settle-rule.js";
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

/** Why Stripe's current state stops the operation. */
export type StripeBlockReason =
  | "failed_refunds_changed"
  | "refund_in_progress"
  | "already_refunded"
  | "refund_failed"
  | "unconfirmed_external_refund"
  | "refund_succeeded"
  | "succeeded_sum_changed"
  | "nothing_refunded"
  | "partial_not_accepted";

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

/** A refusal of the table. */
type Blocked = Extract<AssessResult, { outcome: "blocked" }>;

const LOT_STATE_CHANGED: Blocked = { outcome: "blocked", code: "lot_state_changed" };

/**
 * A blocked answer naming Stripe's state.
 * @param reason - Which part of Stripe's state stops it.
 * @returns The answer.
 */
function stripeBlocks(reason: StripeBlockReason): Blocked {
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
  if (ops.some(isInFlight)) return { outcome: "blocked", code: "operation_in_progress" };

  const unresolved = pickUnresolvedFailedRefunds(lot.lifecycle, refunds);
  if (kind === "retry" && !latestIsOpenAttention(ops)) return LOT_STATE_CHANGED;
  if (kind === "refund_again") {
    if (unresolved.length === 0) return LOT_STATE_CHANGED;
    if (!fromPreview && !sameIds(input.failedRefundIds, unresolved)) {
      return stripeBlocks("failed_refunds_changed");
    }
  }
  if (refundInProgress(refunds)) return stripeBlocks("refund_in_progress");
  if (kind === "refund_again") {
    const amountCents = unresolved.reduce((sum, r) => sum + r.amountCents, 0);
    return { outcome: "create_refund", amountCents, sendAmount: true };
  }

  const succeeded = succeededCents(refunds);
  if (succeeded >= payment.paidCents) return stripeBlocks("already_refunded");
  // Stripe keeps a failed refund's amount out of what it will still refund
  // (inner#1410 §5.2, measured in test mode).
  const refundable = payment.paidCents - succeeded - failedCents(refunds);
  if (refundable <= 0) return stripeBlocks("refund_failed");
  if (!fromPreview) {
    const confirmed = new Set(input.confirmedRefundIds);
    if (
      refunds.some(
        (r) => r.status === "succeeded" && r.operationId === null && !confirmed.has(r.stripeRefundId),
      )
    ) {
      return stripeBlocks("unconfirmed_external_refund");
    }
  }
  return { outcome: "create_refund", amountCents: refundable, sendAmount: false };
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
  const kinds = Object.keys(REQUIRED_LIFECYCLE) as RefundCreateKind[];
  return kinds.find((k) => REQUIRED_LIFECYCLE[k] === lifecycle) ?? null;
}

/**
 * Whether a disposition is still being carried out.
 * @param op - The disposition.
 * @param op.status - Its status.
 * @returns True for `started` and `awaiting_stripe`.
 */
export function isInFlight(op: { status: AssessOperation["status"] }): boolean {
  return op.status === "started" || op.status === "awaiting_stripe";
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

/** The four dispositions that finish in their request (§5.3). */
export type OneShotKind = "reject" | "settle" | "send_back" | "resolve_outside";

/** The facts a one-shot disposition is judged on, and what its request sent. */
export interface OneShotInput {
  kind: OneShotKind;
  lot: { lifecycle: CreditLotLifecycle; remainingCredits: number };
  paidCents: number;
  ops: readonly AssessOperation[];
  refunds: readonly RefundCopy[];
  /** settle only. */
  confirmedSucceededCents?: number;
  /** settle only. */
  acceptPartial?: boolean;
  /** resolve_outside only. */
  failedRefundIds?: readonly string[];
}

/** The lot states each one-shot kind starts from. */
const ONE_SHOT_LIFECYCLES: Record<OneShotKind, readonly CreditLotLifecycle[]> = {
  reject: ["refund_pending"],
  settle: ["refunding", "refund_pending"],
  send_back: ["refunding"],
  resolve_outside: ["refunded", "refunding", "refund_pending"],
};

/**
 * Judge a reject, settle, send-back or resolved-outside request (§5.3):
 * the lot's state, nothing in flight, then Stripe's current state.
 * @param input - The facts and the request.
 * @returns `proceed`, or why not.
 */
export function assessOneShot(input: OneShotInput): { outcome: "proceed" } | Blocked {
  const { kind, lot, refunds } = input;
  if (!ONE_SHOT_LIFECYCLES[kind].includes(lot.lifecycle)) return LOT_STATE_CHANGED;
  if (kind === "reject" && lot.remainingCredits <= 0) return LOT_STATE_CHANGED;
  if (input.ops.some(isInFlight)) return { outcome: "blocked", code: "operation_in_progress" };
  if (kind === "resolve_outside") {
    const unresolved = pickUnresolvedFailedRefunds(lot.lifecycle, refunds);
    // A booked lot has nothing to answer for unless a refund failed since;
    // a lot not yet booked may be refunded outside with none failed.
    if (lot.lifecycle === "refunded" && unresolved.length === 0) return LOT_STATE_CHANGED;
    if (!sameIds(input.failedRefundIds ?? [], unresolved)) return stripeBlocks("failed_refunds_changed");
  }
  if (refundInProgress(refunds)) return stripeBlocks("refund_in_progress");
  const succeeded = succeededCents(refunds);
  if ((kind === "reject" || kind === "send_back") && succeeded > 0) {
    return stripeBlocks("refund_succeeded");
  }
  if (kind === "settle") {
    if (succeeded !== input.confirmedSucceededCents) return stripeBlocks("succeeded_sum_changed");
    if (succeeded === 0) return stripeBlocks("nothing_refunded");
    if (succeeded < input.paidCents && !input.acceptPartial) return stripeBlocks("partial_not_accepted");
  }
  return { outcome: "proceed" };
}
