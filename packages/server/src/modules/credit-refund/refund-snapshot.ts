// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one writer of `credit_refunds` (inner#1410 §6.4): every read of a
 * payment's refunds from Stripe is copied here, and the payment's disposition
 * waiting on Stripe, if any, is judged again in the same transaction.
 */

import type { DbTx } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import {
  transitionOperation,
  type OperationEvent,
} from "@server/modules/credit-refund/operation-transitions.js";
import * as refundCopyRepo from "@server/modules/credit-refund/refund-copy.repo.js";
import { canSettle, refundAgainOutcome } from "@server/modules/credit-refund/settle-rule.js";
import { eventForRefund } from "@server/modules/credit-refund/stripe-answer.js";
import type { RefundCopy, StripeRefundObject } from "@server/modules/credit-refund/types.js";
import { pickUnresolvedFailedRefunds } from "@server/modules/credit-refund/unresolved.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";

export type { StripeRefundObject } from "@server/modules/credit-refund/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Copy what Stripe listed for a payment, then re-judge its disposition that
 * waits on Stripe. Locks in the §9 order: lot, disposition, copies.
 * @param tx - The caller's transaction.
 * @param paymentId - The payment.
 * @param refunds - Every refund Stripe holds for it (`refunds.list`, all pages).
 * @throws {Error} When the payment opened no lot, or the refund a waiting
 *   disposition names is missing from the list.
 */
export async function applyRefundSnapshot(
  tx: DbTx,
  paymentId: string,
  refunds: readonly StripeRefundObject[],
): Promise<void> {
  const lot = await creditLotRepo.lockLotByPayment(paymentId, tx);
  if (lot === null) throw new Error(`payment ${paymentId} opened no credit lot`);
  const awaitingId = await operationRepo.findAwaiting(paymentId, tx);
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
      },
      tx,
    );
  }
  if (awaiting !== null) {
    await transitionOperation(tx, { id: awaiting.id }, await judgeAwaiting(tx, awaiting, refunds));
  }
}

/**
 * The §5.4 event for a disposition's own refund, read against the copies
 * already written in this transaction: approve and retry by the settle
 * rule, refund_again by its own refund alone.
 * @param tx - The caller's transaction.
 * @param op - The disposition.
 * @param own - Its refund, as Stripe reported it.
 * @returns The event.
 */
export async function judgeOwnRefund(
  tx: DbTx,
  op: CreditRefundOperation,
  own: StripeRefundObject,
): Promise<OperationEvent> {
  if (op.kind === "refund_again") {
    const type = eventForRefund(own.status, refundAgainOutcome(own.status));
    return type === "E6" ? { type, refund: own } : { type: type as "E2" | "E5", refund: own };
  }
  const paid = await paymentRepo.readPaidAmount(op.paymentId, tx);
  const verdict = canSettle({
    refunds: await refundCopyRepo.listForPayment(op.paymentId, tx),
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
 * or E10 when a disposition left after a 5xx still has none.
 * @param tx - The caller's transaction.
 * @param op - The waiting disposition.
 * @param refunds - What Stripe listed.
 * @returns The event.
 */
async function judgeAwaiting(
  tx: DbTx,
  op: CreditRefundOperation,
  refunds: readonly StripeRefundObject[],
): Promise<OperationEvent> {
  const own =
    op.stripeRefundId === null
      ? refunds.find((r) => r.metadata?.refund_operation_id === op.id)
      : refunds.find((r) => r.id === op.stripeRefundId);
  if (own !== undefined) return judgeOwnRefund(tx, op, own);
  if (op.stripeRefundId === null) return { type: "E10" };
  throw new Error(
    `refund ${op.stripeRefundId} of disposition ${op.id} is missing from Stripe's list; pass every page`,
  );
}

/**
 * The failed refunds of a lot nobody has answered for (§5.3), seen from the
 * caller's transaction.
 * @param tx - The caller's transaction.
 * @param lotId - The lot.
 * @returns The copies, by refund id.
 */
export async function unresolvedFailedRefunds(tx: DbTx, lotId: string): Promise<RefundCopy[]> {
  const lot = await creditLotRepo.lockLot(lotId, tx);
  if (lot === null) return [];
  return pickUnresolvedFailedRefunds(lot.lifecycle, await refundCopyRepo.listForLot(lotId, tx));
}
