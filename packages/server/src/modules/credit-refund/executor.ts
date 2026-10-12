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
  type Actor,
  type OperationEvent,
} from "@server/modules/credit-refund/operation-transitions.js";
import { applyRefundSnapshot, judgeOwnRefund } from "@server/modules/credit-refund/refund-snapshot.js";
import { classifyCreateAnswer } from "@server/modules/credit-refund/stripe-answer.js";
import {
  StripeReadError,
  createRefund,
  listRefunds,
} from "@server/modules/credit-refund/stripe-refunds.js";
import type { StripeRefundObject } from "@server/modules/credit-refund/types.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";

/** One attempt's identity: the disposition, its lease and who runs it. */
interface Attempt {
  op: CreditRefundOperation;
  leaseToken: string;
  actor: Actor | undefined;
}

/**
 * Make one attempt for a `started` disposition whose lease the caller holds.
 * An attempt after the first looks the refund up before asking again: Stripe
 * keeps an idempotency key only 24 hours, and the resume may come later.
 * @param op - The disposition, as the caller last read it with its lease.
 * @param actor - Who runs the attempt: the endpoint or the loop, for the event rows.
 * @returns Once the attempt's cell is committed.
 * @throws {Error} When the payment has no payment intent to refund.
 */
export async function executeRefund(op: CreditRefundOperation, actor?: Actor): Promise<void> {
  if (op.leaseToken === null) throw new Error(`disposition ${op.id} holds no lease`);
  const attempt: Attempt = { op, leaseToken: op.leaseToken, actor };
  const payment = await paymentRepo.getPaymentById(op.paymentId);
  const paymentIntent = payment?.stripePaymentIntentId;
  if (!paymentIntent) throw new Error(`payment ${op.paymentId} has no payment intent`);

  if (op.firstCalledAt !== null) {
    const listed = await read(attempt, paymentIntent);
    if (listed === null) return;
    const found = ownRefundIn(listed, op.id);
    if (found) return judgeAndAnswer(attempt, found, listed);
  }

  await operationRepo.markFirstCalled(op.id, attempt.leaseToken);
  const created = await createRefund({
    operationId: op.id,
    paymentIntent,
    amountCents: op.kind === "refund_again" ? op.refundAmountCents : null,
  });
  const verdict = classifyCreateAnswer(created.answer, op.attemptCount);
  if (verdict.kind === "event") {
    return answer(attempt, { type: verdict.event, failure: created.failure! }, []);
  }

  // Settling reads every refund of the payment, and so does the lookup by
  // metadata; a failed read is E16 either way.
  const listed = await read(attempt, paymentIntent);
  if (listed === null) return;
  if (verdict.kind === "refund") {
    // The list was read after the answer: it is the newer word on the refund.
    const own = listed.find((r) => r.id === created.refund!.id);
    return own
      ? judgeAndAnswer(attempt, own, listed)
      : judgeAndAnswer(attempt, created.refund!, [...listed, created.refund!]);
  }
  const found = ownRefundIn(listed, op.id);
  if (found) return judgeAndAnswer(attempt, found, listed);
  return answer(attempt, { type: verdict.ifNotFound, failure: created.failure! }, listed);
}

/**
 * Read every refund of the payment; a failed read is answered as E16.
 * @param attempt - The attempt.
 * @param paymentIntent - The payment intent.
 * @returns The refunds, or null when the read failed and E16 was committed.
 */
async function read(attempt: Attempt, paymentIntent: string): Promise<StripeRefundObject[] | null> {
  try {
    return await listRefunds(paymentIntent);
  } catch (err) {
    if (!(err instanceof StripeReadError)) throw err;
    await answer(attempt, { type: "E16", failure: err.failure }, []);
    return null;
  }
}

/**
 * The disposition's own refund among the payment's, by its metadata.
 * @param listed - Every refund of the payment.
 * @param operationId - The disposition.
 * @returns The refund, or null.
 */
function ownRefundIn(listed: readonly StripeRefundObject[], operationId: string): StripeRefundObject | null {
  return listed.find((r) => r.metadata?.refund_operation_id === operationId) ?? null;
}

/**
 * Copy what was read and execute one cell, in one transaction.
 * @param attempt - The attempt.
 * @param event - The event, without lease and actor.
 * @param listed - The refunds this attempt read; empty when it read none.
 */
async function answer(attempt: Attempt, event: OperationEvent, listed: StripeRefundObject[]): Promise<void> {
  await db.transaction(async (tx) => {
    if (listed.length > 0) await applyRefundSnapshot(tx, attempt.op.paymentId, listed, attempt.actor);
    await transitionOperation(tx, { id: attempt.op.id }, eventOf(attempt, event));
  });
}

/**
 * The event as this attempt answers it: under its lease, naming its actor.
 * @param attempt - The attempt.
 * @param event - The event.
 * @returns The event to execute.
 */
function eventOf(attempt: Attempt, event: OperationEvent): OperationEvent {
  return { ...event, leaseToken: attempt.leaseToken, ...(attempt.actor && { actor: attempt.actor }) };
}

/**
 * Copy what Stripe holds for the payment, judge the disposition's own refund
 * against it, and execute the cell — all in one transaction.
 * @param attempt - The attempt.
 * @param own - Its refund.
 * @param listed - Every refund of the payment, with `own` as last seen.
 */
async function judgeAndAnswer(
  attempt: Attempt,
  own: StripeRefundObject,
  listed: StripeRefundObject[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await applyRefundSnapshot(tx, attempt.op.paymentId, listed, attempt.actor);
    await transitionOperation(tx, { id: attempt.op.id }, eventOf(attempt, await judgeOwnRefund(tx, attempt.op, own)));
  });
}
