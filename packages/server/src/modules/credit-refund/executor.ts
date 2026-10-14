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

/** One read of Stripe: a whole `refunds.list`, or the one refund a create answered with. */
interface Read {
  refunds: StripeRefundObject[];
  list: boolean;
}

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
 * @returns Once the attempt's cell is committed and the buyer mail it queued
 *   is on its way; at once, with only what it read copied, when its lease no
 *   longer covers a Stripe call (§9).
 * @throws {Error} When the payment has no payment intent to refund.
 */
export async function executeRefund(op: CreditRefundOperation, actor: Actor): Promise<void> {
  const { attempt, paymentIntent } = await begin(op, actor);
  const config = getCreditRefundConfig();
  // Every read is copied, oldest first (§6.4): the create answer may be the
  // only sight of a success, the list after it the newer word on the status.
  const reads: Read[] = [];
  if (op.firstCalledAt !== null) {
    const listed = await read(attempt, paymentIntent, reads);
    if (listed === null) return;
    reads.push({ refunds: listed, list: true });
    const found = ownRefundIn(listed, op.id);
    if (found) return commit(attempt, reads, (tx) => judgeOwnRefund(tx, op, found));
    // Stripe holds none of it and no attempt is left: a person decides.
    if (attemptsExhausted(op.attemptCount, config)) return commit(attempt, reads, () => ({ type: "E11" }));
  }

  // A lease taken over or about to run out must not reach Stripe: the loop
  // claims the row and carries on under its own lease (§9).
  if (!(await operationRepo.markFirstCalled(op.id, attempt.leaseToken, config.stripeCallTimeoutMs))) {
    logger.warn({ operationId: op.id }, "credit_refund_create_skipped_lease");
    return commit(attempt, reads);
  }
  const created = await createRefund({ operationId: op.id, paymentIntent });
  const verdict = classifyCreateAnswer(created.answer, op.attemptCount);
  if (verdict.kind === "event") {
    return commit(attempt, reads, () => ({ type: verdict.event, failure: created.failure! }));
  }

  if (verdict.kind === "refund") reads.push({ refunds: [created.refund!], list: false });
  const listed = await read(attempt, paymentIntent, reads, created.failure);
  if (listed === null) return;
  reads.push({ refunds: listed, list: true });
  if (verdict.kind === "refund") {
    const own = listed.find((r) => r.id === created.refund!.id) ?? created.refund!;
    return commit(attempt, reads, (tx) => judgeOwnRefund(tx, op, own));
  }
  const found = ownRefundIn(listed, op.id);
  if (found) return commit(attempt, reads, (tx) => judgeOwnRefund(tx, op, found));
  return commit(attempt, reads, () => ({ type: verdict.ifNotFound, failure: created.failure! }));
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
  earlier: Read[],
  createFailure?: StripeFailure,
): Promise<StripeRefundObject[] | null> {
  try {
    return await listRefunds(paymentIntent);
  } catch (err) {
    if (!(err instanceof StripeReadError)) throw err;
    await commit(attempt, earlier, () => ({ type: "E16", failure: err.failure, createFailure }));
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
 * Copy what was read, oldest read first, and execute the attempt's cell, in
 * one transaction; then send the buyer mail of this disposition and of any
 * waiting one the copies judged (§6.5 M1).
 * @param attempt - The attempt.
 * @param reads - The refunds this attempt saw, in the order it saw them.
 * @param cell - The event to execute, computed inside the transaction; none
 *   when the attempt stands down and only copies.
 */
async function commit(
  attempt: Attempt,
  reads: Read[],
  cell?: (tx: DbTx) => Promise<OperationEventBody> | OperationEventBody,
): Promise<void> {
  const judged = await db.transaction(async (tx) => {
    const ids = await copyReads(tx, attempt, reads);
    if (cell) await transitionOperation(tx, { id: attempt.op.id }, eventOf(attempt, await cell(tx)));
    return ids;
  });
  for (const id of new Set([attempt.op.id, ...judged])) sendOperationMailsLater(id);
}

/**
 * Copy each read, in order. Only a list read judges the payment's
 * waiting disposition: a create answer is one refund, not the whole list.
 * @param tx - The transaction.
 * @param attempt - The attempt.
 * @param reads - The reads.
 * @returns The waiting dispositions the list reads judged: once this
 *   attempt's lease is gone, that may be one accepted after it.
 */
async function copyReads(tx: DbTx, attempt: Attempt, reads: Read[]): Promise<string[]> {
  const judged: string[] = [];
  for (const { refunds, list } of reads) {
    const id = await applyRefundSnapshot(tx, attempt.op.paymentId, refunds, attempt.actor, { judge: list });
    if (id !== null) judged.push(id);
  }
  return judged;
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
