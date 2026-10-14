// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Copying Stripe's refunds into `credit_refunds` (inner#1410 §6.4): every
 * read of a payment's refunds from Stripe is copied here, and a whole-list
 * read also judges the payment's disposition waiting on Stripe, if any, in
 * the same transaction. `resolved_by_operation_id` is written by `transitionOperation`.
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
 * Copy what Stripe reported for a payment and, for a whole-list read,
 * re-judge its disposition that waits on Stripe. Locks in the §9 order: lot, disposition, copies.
 * @param tx - The caller's transaction.
 * @param paymentId - The payment.
 * @param refunds - What Stripe reported: the whole `refunds.list` (all pages),
 *   or, with `judge: false`, a `refunds.create` answer.
 * @param actor - Who read them, for the event row a re-judged disposition gets.
 * @param options - How to apply them.
 * @param options.judge - False for refunds that are not the whole list (a
 *   `refunds.create` answer): they are copied and judge nothing.
 * @returns The waiting disposition it re-judged, so the caller can send the
 *   buyer mail a finish queued once its transaction commits; null for none.
 * @throws {Error} When the payment opened no lot.
 */
export async function applyRefundSnapshot(
  tx: DbTx,
  paymentId: string,
  refunds: readonly StripeRefundObject[],
  actor: Actor,
  { judge = true }: { judge?: boolean } = {},
): Promise<string | null> {
  const lot = await creditLotRepo.lockLotByPayment(paymentId, tx);
  if (lot === null) throw new Error(`payment ${paymentId} opened no credit lot`);
  const awaitingId = judge ? await operationRepo.findAwaiting(paymentId, tx) : null;
  const awaiting = awaitingId === null ? null : await operationRepo.lockById(awaitingId, tx);

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
        pendingReason: r.pending_reason ?? null,
      },
      tx,
    );
  }
  if (awaiting === null) return null;
  const event = await judgeAwaiting(tx, awaiting, refunds);
  if (event === null) return null;
  await transitionOperation(tx, { id: awaiting.id }, { ...event, actor });
  return awaiting.id;
}

/**
 * The §5.4 event for a disposition's own refund, read against the copies
 * already written in this transaction, by the settle rule.
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
  // failed or canceled (§6.4): the copy's status and reason are the ones judged.
  const copy = copies.find((c) => c.stripeRefundId === read.id);
  const own = copy ? { ...read, status: copy.status, failure_reason: copy.failureReason } : read;
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
