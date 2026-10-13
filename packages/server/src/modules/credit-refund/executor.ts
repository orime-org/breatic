// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Phases 2 and 3 of a disposition that creates a Stripe refund (inner#1410
 * §5.2): call `refunds.create` under the disposition's own idempotency key,
 * classify the answer (§5.4) and execute the cell it lands in. Run by the
 * endpoint right after phase 1, and by the loop for a lease it claimed.
 */

import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import {
  transitionOperation,
  type Actor,
  type OperationEvent,
  type OperationEventBody,
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
  actor: Actor;
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
export async function executeRefund(op: CreditRefundOperation, actor: Actor): Promise<void> {
  const { attempt, paymentIntent } = await begin(op, actor);
  if (op.firstCalledAt !== null) {
    const listed = await read(attempt, paymentIntent, []);
    if (listed === null) return;
    const found = ownRefundIn(listed, op.id);
    if (found) return judgeAndAnswer(attempt, found, [listed]);
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

  // The create answer is copied first, then the list read after it: the
  // list is the newer word on the status, the answer may be the only sight
  // of a success (§6.4).
  const seen = verdict.kind === "refund" ? [created.refund!] : [];
  const listed = await read(attempt, paymentIntent, seen);
  if (listed === null) return;
  if (verdict.kind === "refund") {
    const own = listed.find((r) => r.id === created.refund!.id) ?? created.refund!;
    return judgeAndAnswer(attempt, own, [seen, listed]);
  }
  const found = ownRefundIn(listed, op.id);
  if (found) return judgeAndAnswer(attempt, found, [listed]);
  return answer(attempt, { type: verdict.ifNotFound, failure: created.failure! }, [listed]);
}

/**
 * End a `started` disposition whose attempts are used up (E11) once a read of
 * Stripe shows no refund of it; a refund found is judged (§6.2 E11). A read
 * that fails is E16: the disposition stays in flight until Stripe answers (§9).
 * @param op - The disposition, under the lease the loop just claimed.
 * @param actor - Who ends it.
 * @returns Once the cell is committed.
 * @throws {Error} When the payment has no payment intent.
 */
export async function closeExhausted(op: CreditRefundOperation, actor: Actor): Promise<void> {
  const { attempt, paymentIntent } = await begin(op, actor);
  const listed = await read(attempt, paymentIntent, []);
  if (listed === null) return;
  const found = ownRefundIn(listed, op.id);
  if (found) return judgeAndAnswer(attempt, found, [listed]);
  return answer(attempt, { type: "E11" }, [listed]);
}

/**
 * The attempt's identity and the payment intent it refunds.
 * @param op - The disposition, with its lease.
 * @param actor - Who runs the attempt.
 * @returns Both.
 * @throws {Error} When the row holds no lease or the payment has no intent.
 */
async function begin(
  op: CreditRefundOperation,
  actor: Actor,
): Promise<{ attempt: Attempt; paymentIntent: string }> {
  if (op.leaseToken === null) throw new Error(`disposition ${op.id} holds no lease`);
  const payment = await paymentRepo.getPaymentById(op.paymentId);
  const paymentIntent = payment?.stripePaymentIntentId;
  if (!paymentIntent) throw new Error(`payment ${op.paymentId} has no payment intent`);
  return { attempt: { op, leaseToken: op.leaseToken, actor }, paymentIntent };
}

/**
 * Read every refund of the payment; a failed read is answered as E16, with
 * what the attempt had already seen copied.
 * @param attempt - The attempt.
 * @param paymentIntent - The payment intent.
 * @param seen - Refunds the attempt already holds (the create answer).
 * @returns The refunds, or null when the read failed and E16 was committed.
 */
async function read(
  attempt: Attempt,
  paymentIntent: string,
  seen: StripeRefundObject[],
): Promise<StripeRefundObject[] | null> {
  try {
    return await listRefunds(paymentIntent);
  } catch (err) {
    if (!(err instanceof StripeReadError)) throw err;
    await answer(attempt, { type: "E16", failure: err.failure }, [seen]);
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
 * Copy what was read, oldest read first, and execute one cell, in one transaction.
 * @param attempt - The attempt.
 * @param event - The event, without lease and actor.
 * @param reads - The refunds this attempt saw, in the order it saw them.
 */
async function answer(attempt: Attempt, event: OperationEventBody, reads: StripeRefundObject[][]): Promise<void> {
  await db.transaction(async (tx) => {
    await copyReads(tx, attempt, reads);
    await transitionOperation(tx, { id: attempt.op.id }, eventOf(attempt, event));
  });
}

/**
 * Copy the reads, then judge the disposition's own refund against the copies
 * and execute the cell — all in one transaction.
 * @param attempt - The attempt.
 * @param own - Its refund, as last seen.
 * @param reads - The refunds this attempt saw, in the order it saw them.
 */
async function judgeAndAnswer(
  attempt: Attempt,
  own: StripeRefundObject,
  reads: StripeRefundObject[][],
): Promise<void> {
  await db.transaction(async (tx) => {
    await copyReads(tx, attempt, reads);
    await transitionOperation(tx, { id: attempt.op.id }, eventOf(attempt, await judgeOwnRefund(tx, attempt.op, own)));
  });
}

/**
 * Copy each non-empty read, in order.
 * @param tx - The transaction.
 * @param attempt - The attempt.
 * @param reads - The reads.
 */
async function copyReads(tx: DbTx, attempt: Attempt, reads: StripeRefundObject[][]): Promise<void> {
  for (const refunds of reads) {
    if (refunds.length > 0) await applyRefundSnapshot(tx, attempt.op.paymentId, refunds, attempt.actor);
  }
}

/**
 * The event as this attempt answers it: under its lease, naming its actor.
 * @param attempt - The attempt.
 * @param event - The event.
 * @returns The event to execute.
 */
function eventOf(attempt: Attempt, event: OperationEventBody): OperationEvent {
  return { ...event, leaseToken: attempt.leaseToken, actor: attempt.actor };
}
