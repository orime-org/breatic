// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Copying Stripe's refunds into `credit_refunds` (inner#1410 §6.4): every
 * read of a payment's refunds from Stripe is copied here, and in the same
 * transaction the payment's disposition waiting on Stripe, if any, is judged
 * again, and a refund_again in needs_attention whose own refund now holds
 * succeeded answers for its failed refunds (§6.2). `resolved_by_operation_id`
 * is written by `transitionOperation`.
 */

import type { DbTx } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import {
  transitionOperation,
  type Actor,
  type OperationEventBody,
} from "@server/modules/credit-refund/operation-transitions.js";
import * as refundCopyRepo from "@server/modules/credit-refund/refund-copy.repo.js";
import { canSettle } from "@server/modules/credit-refund/settle-rule.js";
import { eventForRefund } from "@server/modules/credit-refund/stripe-answer.js";
import type { StripeRefundObject } from "@server/modules/credit-refund/types.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";

export type { StripeRefundObject } from "@server/modules/credit-refund/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Copy what Stripe listed for a payment, then re-judge its disposition that
 * waits on Stripe. Locks in the §9 order: lot, disposition, copies.
 * @param tx - The caller's transaction.
 * @param paymentId - The payment.
 * @param refunds - Every refund Stripe holds for it (`refunds.list`, all pages).
 * @param actor - Who read them, for the event row a re-judged disposition gets.
 * @returns The waiting disposition it re-judged, so the caller can send the
 *   buyer mail a finish queued once its transaction commits; null for none.
 * @throws {Error} When the payment opened no lot.
 */
export async function applyRefundSnapshot(
  tx: DbTx,
  paymentId: string,
  refunds: readonly StripeRefundObject[],
  actor: Actor,
): Promise<string | null> {
  const lot = await creditLotRepo.lockLotByPayment(paymentId, tx);
  if (lot === null) throw new Error(`payment ${paymentId} opened no credit lot`);
  const awaitingId = await operationRepo.findAwaiting(paymentId, tx);
  const awaiting = awaitingId === null ? null : await operationRepo.lockById(awaitingId, tx);
  const inAttention = await operationRepo.lockRefundAgainInAttention(paymentId, tx);

  const named = refunds.map((r) => r.metadata?.refund_operation_id ?? "").filter((id) => UUID.test(id));
  const known = new Set(await operationRepo.existingIds(paymentId, named, tx));
  const ordered = [...refunds].sort((a, b) => a.id.localeCompare(b.id));
  for (const r of ordered) {
    const opId = r.metadata?.refund_operation_id;
    await refundCopyRepo.upsert(
      {
        stripeRefundId: r.id,
        paymentId,
        lotId: lot.id,
        operationId: opId !== undefined && known.has(opId) ? opId : null,
        amountCents: r.amount,
        currency: r.currency,
        status: r.status,
        failureReason: r.failure_reason ?? null,
      },
      tx,
    );
  }
  await answerRefundAgainSucceededLater(tx, inAttention, actor);
  if (awaiting === null) return null;
  const event = await judgeAwaiting(tx, awaiting, refunds);
  if (event === null) return null;
  await transitionOperation(tx, { id: awaiting.id }, { ...event, actor });
  return awaiting.id;
}

/**
 * E2 for each refund_again in needs_attention whose own refund's copy holds
 * succeeded while a failed refund it was for is still unanswered: the money
 * went back after a person was asked.
 * @param tx - The caller's transaction, after the copies were written.
 * @param ops - The payment's refund_again dispositions in needs_attention.
 * @param actor - Who read Stripe.
 */
async function answerRefundAgainSucceededLater(
  tx: DbTx,
  ops: readonly CreditRefundOperation[],
  actor: Actor,
): Promise<void> {
  for (const op of ops) {
    const own = await refundCopyRepo.findOwn(op.id, tx);
    if (own?.status !== "succeeded") continue;
    // Re-read per disposition: one answered just now leaves nothing for a second.
    const copies = await refundCopyRepo.listForPayment(op.paymentId, tx);
    const open = copies.some((c) => op.failedRefundIds.includes(c.stripeRefundId) && c.resolvedByOperationId === null);
    if (!open) continue;
    await transitionOperation(tx, { id: op.id }, { type: "E2", refund: own, actor });
  }
}

/**
 * The §5.4 event for a disposition's own refund, read against the copies
 * already written in this transaction: approve and retry by the settle
 * rule, refund_again by its own refund alone.
 * @param tx - The caller's transaction.
 * @param op - The disposition.
 * @param read - Its refund, as Stripe reported it.
 * @returns The event.
 */
export async function judgeOwnRefund(
  tx: DbTx,
  op: CreditRefundOperation,
  read: StripeRefundObject,
): Promise<OperationEventBody> {
  const copies = await refundCopyRepo.listForPayment(op.paymentId, tx);
  // A read older than one already copied cannot take a refund out of
  // failed or canceled (§6.4): the copy's status is the one judged.
  const own = { ...read, status: copies.find((c) => c.stripeRefundId === read.id)?.status ?? read.status };
  if (op.kind === "refund_again") {
    // It asked Stripe for exactly the failed refunds' amount, so its own
    // refund alone decides: succeeded settles.
    const type = eventForRefund(own.status, "settle");
    return type === "E6" ? { type, refund: own } : { type: type as "E2" | "E5", refund: own };
  }
  const paid = await paymentRepo.readPaidAmount(op.paymentId, tx);
  const verdict = canSettle({
    refunds: copies,
    paidCents: paid!.paidCents,
    confirmedRefundIds: op.confirmedRefundIds,
  });
  const type = eventForRefund(own.status, verdict.outcome);
  if (type === "E4" && verdict.outcome === "attention") {
    return { type, refund: own, reason: verdict.reason };
  }
  return type === "E6" ? { type, refund: own } : { type: type as "E2" | "E3" | "E5", refund: own };
}

/**
 * The event a snapshot brings a waiting disposition: its own refund judged,
 * or E10 when a disposition left after a 5xx still has none. A list read
 * before the disposition's refund existed (a request's step 0 racing
 * another request's phase 2) says nothing about it: no event.
 * @param tx - The caller's transaction.
 * @param op - The waiting disposition.
 * @param refunds - What Stripe listed.
 * @returns The event, or null to leave the disposition as it is.
 */
async function judgeAwaiting(
  tx: DbTx,
  op: CreditRefundOperation,
  refunds: readonly StripeRefundObject[],
): Promise<OperationEventBody | null> {
  const own =
    op.stripeRefundId === null
      ? refunds.find((r) => r.metadata?.refund_operation_id === op.id)
      : refunds.find((r) => r.id === op.stripeRefundId);
  if (own !== undefined) return judgeOwnRefund(tx, op, own);
  return op.stripeRefundId === null ? { type: "E10" } : null;
}
