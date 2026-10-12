// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Phases 2 and 3 of a disposition that creates a Stripe refund (inner#1410
 * §5.2): call `refunds.create` under the disposition's own idempotency key,
 * classify the answer (§5.4) and execute the cell it lands in. Run by the
 * endpoint right after phase 1, and by the loop for a lease it claimed.
 */

import { db } from "@breatic/core";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import {
  transitionOperation,
  type OperationEvent,
} from "@server/modules/credit-refund/operation-transitions.js";
import { applyRefundSnapshot, judgeOwnRefund } from "@server/modules/credit-refund/refund-snapshot.js";
import { classifyCreateAnswer, classifyLookup } from "@server/modules/credit-refund/stripe-answer.js";
import {
  StripeReadError,
  createRefund,
  listRefunds,
} from "@server/modules/credit-refund/stripe-refunds.js";
import type { StripeRefundObject } from "@server/modules/credit-refund/types.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";

/**
 * Make one attempt for a `started` disposition whose lease the caller holds.
 * @param op - The disposition, as the caller last read it with its lease.
 * @returns Once the attempt's cell is committed.
 * @throws {Error} When the payment has no payment intent to refund.
 */
export async function executeRefund(op: CreditRefundOperation): Promise<void> {
  const leaseToken = op.leaseToken;
  if (leaseToken === null) throw new Error(`disposition ${op.id} holds no lease`);
  const payment = await paymentRepo.getPaymentById(op.paymentId);
  const paymentIntent = payment?.stripePaymentIntentId;
  if (!paymentIntent) throw new Error(`payment ${op.paymentId} has no payment intent`);

  await operationRepo.markFirstCalled(op.id, leaseToken);
  const created = await createRefund({
    operationId: op.id,
    paymentIntent,
    amountCents: op.kind === "refund_again" ? op.refundAmountCents : null,
  });
  const verdict = classifyCreateAnswer(created.answer, op.attemptCount);
  if (verdict.kind === "event") {
    return answer(op, { type: verdict.event, failure: created.failure!, leaseToken });
  }

  // Settling reads every refund of the payment, and so does the lookup by
  // metadata; a failed read is E16 either way.
  let listed: StripeRefundObject[];
  try {
    listed = await listRefunds(paymentIntent);
  } catch (err) {
    if (!(err instanceof StripeReadError)) throw err;
    return answer(op, { type: "E16", failure: err.failure, leaseToken });
  }
  if (verdict.kind === "refund") {
    const own = created.refund!;
    return judgeAndAnswer(op, own, [...listed.filter((r) => r.id !== own.id), own], leaseToken);
  }
  const found = listed.find((r) => r.metadata?.refund_operation_id === op.id) ?? null;
  const lookup = classifyLookup(verdict.ifNotFound, { ok: true, refund: found });
  if (lookup.kind === "refund") return judgeAndAnswer(op, found!, listed, leaseToken);
  return answer(op, { type: lookup.event, failure: created.failure!, leaseToken });
}

/**
 * Execute one cell in its own transaction.
 * @param op - The disposition.
 * @param event - The event, carrying the lease.
 */
async function answer(op: CreditRefundOperation, event: OperationEvent): Promise<void> {
  await db.transaction((tx) => transitionOperation(tx, { id: op.id }, event));
}

/**
 * Copy what Stripe holds for the payment, judge the disposition's own refund
 * against it, and execute the cell — all in one transaction.
 * @param op - The disposition.
 * @param own - Its refund.
 * @param listed - Every refund of the payment, with `own` as last seen.
 * @param leaseToken - The lease the answer is made under.
 */
async function judgeAndAnswer(
  op: CreditRefundOperation,
  own: StripeRefundObject,
  listed: StripeRefundObject[],
  leaseToken: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await applyRefundSnapshot(tx, op.paymentId, listed);
    const event = await judgeOwnRefund(tx, op, own);
    await transitionOperation(tx, { id: op.id }, { ...event, leaseToken });
  });
}
