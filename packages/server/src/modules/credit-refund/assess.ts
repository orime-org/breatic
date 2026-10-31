// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The judgement table shared by the preview and the two endpoints that
 * create a Stripe refund, approve and retry (inner#1410 §5.2), and the
 * judgement of the five dispositions that finish in their request (§5.3).
 *
 * Rows are read top to bottom and the first match answers. The preview reads
 * the same rows without what the confirmation page sends back, so the page
 * never shows "will refund" for a request the endpoint would then refuse.
 */

import type { CreditLotLifecycle } from "@breatic/shared";
import type { AttentionReason, OperationResult } from "@server/modules/credit-refund/operation.repo.js";
import {
  hasUnconfirmedExternal,
  refundInProgress,
  succeededCents,
} from "@server/modules/credit-refund/settle-rule.js";
import type { RefundCopy } from "@server/modules/credit-refund/types.js";
import type { UnresolvedFailedRefund } from "@server/modules/credit-refund/unresolved.repo.js";

/** The two dispositions that create a Stripe refund. */
export type RefundCreateKind = "approve" | "retry";

/** What the tables need to know about one earlier disposition of the lot. */
export interface AssessOperation {
  status: "started" | "awaiting_stripe" | "succeeded" | "needs_attention";
  attentionClosedAt: Date | null;
  createdAt: Date;
  result: OperationResult | null;
  attentionReason: AttentionReason | null;
}

/** The facts the table reads, as one endpoint receives them. */
export interface AssessInput {
  kind: RefundCreateKind;
  lot: { lifecycle: CreditLotLifecycle; remainingCredits: number; ledgerSum: number };
  payment: { status: string; stripePaymentIntentId: string | null; paidCents: number } | null;
  ops: readonly AssessOperation[];
  refunds: readonly RefundCopy[];
  confirmedRefundIds: readonly string[];
}

/** Why Stripe's current state, or the lot's disposition history, stops the operation. */
export type StripeBlockReason =
  | "failed_refunds_changed"
  | "refund_in_progress"
  | "already_refunded"
  | "refund_failed"
  | "unconfirmed_external_refund"
  | "refund_succeeded"
  | "succeeded_sum_changed"
  | "succeeded_below_paid"
  | "stripe_declined"
  | "paid_outside"
  | "disputed";

/** The table's answer. */
export type AssessResult =
  | { outcome: "create_refund"; amountCents: number }
  | { outcome: "blocked"; code: "lot_state_changed" | "operation_in_progress" }
  | { outcome: "blocked"; code: "stripe_blocks"; reason: StripeBlockReason };

/** The lot state each kind starts from. */
const REQUIRED_LIFECYCLE: Record<RefundCreateKind, CreditLotLifecycle> = {
  approve: "refund_pending",
  retry: "refunding",
};

/** A refusal of the table. */
type Blocked = Extract<AssessResult, { outcome: "blocked" }>;

const LOT_STATE_CHANGED: Blocked = { outcome: "blocked", code: "lot_state_changed" };
const IN_PROGRESS: Blocked = { outcome: "blocked", code: "operation_in_progress" };

/**
 * A blocked answer naming Stripe's state.
 * @param reason - Which part of Stripe's state stops it.
 * @returns The answer.
 */
function stripeBlocks(reason: StripeBlockReason): Blocked {
  return { outcome: "blocked", code: "stripe_blocks", reason };
}

/**
 * Run the table. `fromPreview` skips the row that compares against what the
 * confirmation page sends back.
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
  if (ops.some(isInFlight)) return IN_PROGRESS;
  if (kind === "retry" && !latestIsOpenAttention(ops)) return LOT_STATE_CHANGED;
  if (refundInProgress(refunds)) return stripeBlocks("refund_in_progress");
  // Once a card refund has failed, Stripe refuses every later refund of the
  // payment (§5.2, measured 2026-10-14). A canceled one moved no money.
  if (refunds.some((r) => r.status === "failed")) return stripeBlocks("refund_failed");
  const succeeded = succeededCents(refunds);
  if (succeeded >= payment.paidCents) return stripeBlocks("already_refunded");
  if (!fromPreview && hasUnconfirmedExternal(refunds, input.confirmedRefundIds)) {
    return stripeBlocks("unconfirmed_external_refund");
  }
  return { outcome: "create_refund", amountCents: payment.paidCents - succeeded };
}

/**
 * Whether the lot's latest disposition is a needs_attention nobody closed.
 * @param ops - The lot's dispositions, in any order.
 * @returns True when a retry or a restore on a refunding lot may start.
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
function sameIds(ids: readonly string[], refunds: readonly UnresolvedFailedRefund[]): boolean {
  const named = new Set(ids);
  return named.size === refunds.length && refunds.every((r) => named.has(r.stripeRefundId));
}

/**
 * Judge a request to create a refund, as approve or retry receives it.
 * @param input - The facts and what the confirmation page sent back.
 * @returns The answer.
 */
export function assessRefundCreate(input: AssessInput): AssessResult {
  return judge(input, false);
}

/**
 * The operation the preview judges for a lot in this state.
 * @param lifecycle - The lot's lifecycle.
 * @returns The kind, or null when the lot is in neither state that creates a refund.
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

/** The one-shot answer: go ahead, or why not. */
export type OneShotResult = { outcome: "proceed" } | Blocked;

/** What the confirmation page reads. */
export interface PreviewInput {
  lot: AssessInput["lot"];
  payment: AssessInput["payment"];
  ops: readonly AssessOperation[];
  refunds: readonly RefundCopy[];
  unresolvedFailedRefunds: readonly UnresolvedFailedRefund[];
  disputed: boolean;
}

/**
 * What the confirmation page shows: the create operation the lot's state
 * allows and what it would do now, plus all four one-shot actions and the
 * restore answer, each judged by its endpoint rule on the current facts.
 * @param input - The facts, without any confirmation.
 * @returns The create answer, four complete one-shot answers, and the restore answer.
 */
export function assessRefundPreview(
  input: PreviewInput,
): ({ kind: RefundCreateKind; result: AssessResult } | { kind: null }) & { restoreCredits: OneShotResult; oneShot: Record<Exclude<OneShotKind, "restore_credits">, OneShotResult> } {
  const restoreCredits = assessOneShot({
    kind: "restore_credits",
    lot: input.lot,
    paidCents: input.payment?.paidCents ?? 0,
    ops: input.ops,
    refunds: input.refunds,
    unresolvedFailedRefunds: input.unresolvedFailedRefunds,
    disputed: input.disputed,
    failedRefundIds: input.unresolvedFailedRefunds.map((r) => r.stripeRefundId),
  });
  const oneShot = Object.fromEntries(
    (["reject", "settle", "send_back", "resolve_outside"] as const).map((kind) => [kind, assessOneShot({
      ...input,
      kind,
      paidCents: input.payment?.paidCents ?? 0,
      confirmedSucceededCents: succeededCents(input.refunds),
      failedRefundIds: input.unresolvedFailedRefunds.map((r) => r.stripeRefundId),
    })]),
  ) as Record<Exclude<OneShotKind, "restore_credits">, OneShotResult>;
  const kind = previewKind(input.lot.lifecycle);
  if (kind === null) return { kind: null, restoreCredits, oneShot };
  const result = judge({ ...input, kind, confirmedRefundIds: [] }, true);
  return { kind, result, restoreCredits, oneShot };
}

/** The five dispositions that finish in their request (§5.3). */
export type OneShotKind = "reject" | "settle" | "send_back" | "resolve_outside" | "restore_credits";

/** The facts a one-shot disposition is judged on, and what its request sent. */
export interface OneShotInput {
  kind: OneShotKind;
  lot: { lifecycle: CreditLotLifecycle; remainingCredits: number };
  paidCents: number;
  ops: readonly AssessOperation[];
  refunds: readonly RefundCopy[];
  /** The lot's unresolved failed refunds, read from the view (§5.3). */
  unresolvedFailedRefunds: readonly UnresolvedFailedRefund[];
  /** Whether Stripe holds the charge as disputed (restore_credits reads it). */
  disputed: boolean;
  /** settle and resolve_outside. */
  confirmedSucceededCents?: number;
  /** resolve_outside and restore_credits. */
  failedRefundIds?: readonly string[];
}

/** The lot states each one-shot kind other than restore_credits starts from. */
const ONE_SHOT_LIFECYCLES: Record<Exclude<OneShotKind, "restore_credits">, readonly CreditLotLifecycle[]> = {
  reject: ["refund_pending"],
  settle: ["refunding", "refund_pending"],
  send_back: ["refunding"],
  resolve_outside: ["refunded", "refunding", "refund_pending"],
};

/**
 * Judge one of the five one-shot requests (§5.3): the lot column, then the
 * Stripe column, each left to right; the first failing condition answers.
 * @param input - The facts and the request.
 * @returns `proceed`, or why not.
 */
export function assessOneShot(input: OneShotInput): OneShotResult {
  if (input.kind === "restore_credits") return assessRestore(input);
  const { kind, lot, refunds, ops } = input;
  const unresolved = input.unresolvedFailedRefunds;
  if (!ONE_SHOT_LIFECYCLES[kind].includes(lot.lifecycle)) return LOT_STATE_CHANGED;
  if (kind === "reject" && lot.remainingCredits <= 0) return LOT_STATE_CHANGED;
  if (ops.some(isInFlight)) return IN_PROGRESS;
  // A lot Stripe once refused is a failed refund to answer for; sending it
  // back would let a reject tell the buyer the approved ask was turned down.
  if (kind === "send_back" && ops.some((o) => o.attentionReason === "stripe_declined")) {
    return stripeBlocks("stripe_declined");
  }
  if (kind === "resolve_outside") {
    // A booked lot has nothing to answer for unless a refund failed since;
    // a lot not yet booked may be refunded outside with none failed.
    if (lot.lifecycle === "refunded" && unresolved.length === 0) return LOT_STATE_CHANGED;
    if (!sameIds(input.failedRefundIds ?? [], unresolved)) return stripeBlocks("failed_refunds_changed");
  }
  if (refundInProgress(refunds)) return stripeBlocks("refund_in_progress");
  const succeeded = succeededCents(refunds);
  if ((kind === "reject" || kind === "send_back") && succeeded > 0) return stripeBlocks("refund_succeeded");
  if (kind === "reject" && unresolved.length > 0) return stripeBlocks("refund_failed");
  // A refund that succeeded after the operator looked must not be booked as
  // money paid outside, nor settled on a sum nobody confirmed.
  if ((kind === "settle" || kind === "resolve_outside") && succeeded !== input.confirmedSucceededCents) {
    return stripeBlocks("succeeded_sum_changed");
  }
  if (kind === "settle" && succeeded < input.paidCents) return stripeBlocks("succeeded_below_paid");
  return { outcome: "proceed" };
}

/**
 * Restoring credits (§5.3): only once a refund is left unanswered (an
 * unresolved failed refund on a `refunded` or `refund_pending` lot, or an open
 * needs_attention as the latest disposition on a `refunding` lot), and only
 * while no money reached the buyer by Stripe, by a payment outside, or by a
 * dispute.
 * @param input - The facts and the request.
 * @returns `proceed`, or why not.
 */
function assessRestore(input: OneShotInput): OneShotResult {
  const { lot, ops, refunds } = input;
  const unresolved = input.unresolvedFailedRefunds;
  if (ops.some(isInFlight)) return IN_PROGRESS;
  // Holds for the lot for good, so it is answered before the lot's state.
  if (ops.some((o) => o.result === "resolved_outside")) return stripeBlocks("paid_outside");
  if (lot.lifecycle === "refunded" || lot.lifecycle === "refund_pending") {
    if (unresolved.length === 0) return LOT_STATE_CHANGED;
  } else if (lot.lifecycle !== "refunding" || !latestIsOpenAttention(ops)) {
    return LOT_STATE_CHANGED;
  }
  if (input.disputed) return stripeBlocks("disputed");
  if (!sameIds(input.failedRefundIds ?? [], unresolved)) return stripeBlocks("failed_refunds_changed");
  if (refundInProgress(refunds)) return stripeBlocks("refund_in_progress");
  if (refunds.some((r) => r.status === "succeeded")) return stripeBlocks("refund_succeeded");
  return { outcome: "proceed" };
}
