// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Phases 2 and 3 of a disposition that creates a Stripe refund (inner#1410
 * §5.2): call `refunds.create` under the disposition's own idempotency key,
 * classify the answer (§5.4) and execute the cell it lands in. Run by the
 * endpoint right after phase 1, and by the loop for a lease it claimed.
 */

import { db, logger } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import { attemptsExhausted } from "@server/modules/credit-refund/backoff.js";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import {
  transitionOperation,
  type Actor,
  type OperationEvent,
  type OperationEventBody,
  type StripeFailure,
} from "@server/modules/credit-refund/operation-transitions.js";
import { sendOperationMailsLater } from "@server/modules/credit-refund/refund-mail.js";
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
 * keeps an idempotency key only 24 hours, and the resume may come later. With
 * no attempt left, a lookup that finds nothing ends it (E11); a lookup that
 * fails leaves it in flight until Stripe answers (§9).
 * @param op - The disposition, as the caller last read it with its lease.
 * @param actor - Who runs the attempt: the endpoint or the loop, for the event rows.
 * @returns Once the attempt's cell is committed; at once, with only what it
 *   read copied, when its lease no longer covers a Stripe call (§9).
 * @throws {Error} When the payment has no payment intent to refund.
 */
export async function executeRefund(op: CreditRefundOperation, actor: Actor): Promise<void> {
  const { attempt, paymentIntent } = await begin(op, actor);
  const config = getCreditRefundConfig();
  // Every read is copied, oldest first (§6.4): the create answer may be the
  // only sight of a success, the list after it the newer word on the status.
  const reads: StripeRefundObject[][] = [];
  if (op.firstCalledAt !== null) {
    const listed = await read(attempt, paymentIntent, reads);
    if (listed === null) return;
    reads.push(listed);
    const found = ownRefundIn(listed, op.id);
    if (found) return judgeAndAnswer(attempt, found, reads);
    // Stripe holds none of it and no attempt is left: a person decides.
    if (attemptsExhausted(op.attemptCount, config)) return answer(attempt, { type: "E11" }, reads);
  }

  // A lease taken over or about to run out must not reach Stripe: the loop
  // claims the row and carries on under its own lease (§9).
  if (!(await operationRepo.markFirstCalled(op.id, attempt.leaseToken, config.stripeCallTimeoutMs))) {
    logger.warn({ operationId: op.id }, "credit_refund_create_skipped_lease");
    sendJudgedMails(await db.transaction((tx) => copyReads(tx, attempt, reads)));
    return;
  }
  const created = await createRefund({
    operationId: op.id,
    paymentIntent,
    amountCents: op.kind === "refund_again" ? op.refundAmountCents : null,
  });
  const verdict = classifyCreateAnswer(created.answer, op.attemptCount);
  if (verdict.kind === "event") {
    return answer(attempt, { type: verdict.event, failure: created.failure! }, reads);
  }

  if (verdict.kind === "refund") reads.push([created.refund!]);
  const listed = await read(attempt, paymentIntent, reads, created.failure);
  if (listed === null) return;
  reads.push(listed);
  if (verdict.kind === "refund") {
    const own = listed.find((r) => r.id === created.refund!.id) ?? created.refund!;
    return judgeAndAnswer(attempt, own, reads);
  }
  const found = ownRefundIn(listed, op.id);
  if (found) return judgeAndAnswer(attempt, found, reads);
  return answer(attempt, { type: verdict.ifNotFound, failure: created.failure! }, reads);
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
 * @param earlier - The reads the attempt already holds, oldest first.
 * @param createFailure - The create's error, when this read follows it.
 * @returns The refunds, or null when the read failed and E16 was committed.
 */
async function read(
  attempt: Attempt,
  paymentIntent: string,
  earlier: StripeRefundObject[][],
  createFailure?: StripeFailure,
): Promise<StripeRefundObject[] | null> {
  try {
    return await listRefunds(paymentIntent);
  } catch (err) {
    if (!(err instanceof StripeReadError)) throw err;
    await answer(attempt, { type: "E16", failure: err.failure, createFailure }, earlier);
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
  const judged = await db.transaction(async (tx) => {
    const ids = await copyReads(tx, attempt, reads);
    await transitionOperation(tx, { id: attempt.op.id }, eventOf(attempt, event));
    return ids;
  });
  sendJudgedMails(judged);
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
  const judged = await db.transaction(async (tx) => {
    const ids = await copyReads(tx, attempt, reads);
    await transitionOperation(tx, { id: attempt.op.id }, eventOf(attempt, await judgeOwnRefund(tx, attempt.op, own)));
    return ids;
  });
  sendJudgedMails(judged);
}

/**
 * Copy each non-empty read, in order.
 * @param tx - The transaction.
 * @param attempt - The attempt.
 * @param reads - The reads.
 * @returns The waiting dispositions the copies judged: once this attempt's
 *   lease is gone, that may be one accepted after it, whose buyer mail the
 *   caller sends after the commit.
 */
async function copyReads(tx: DbTx, attempt: Attempt, reads: StripeRefundObject[][]): Promise<string[]> {
  const judged: string[] = [];
  for (const refunds of reads) {
    if (refunds.length === 0) continue;
    const id = await applyRefundSnapshot(tx, attempt.op.paymentId, refunds, attempt.actor);
    if (id !== null) judged.push(id);
  }
  return judged;
}

/**
 * Send the buyer mail the copies queued for the dispositions they judged.
 * @param ids - The dispositions, after their transaction committed.
 */
function sendJudgedMails(ids: readonly string[]): void {
  for (const id of ids) sendOperationMailsLater(id);
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
