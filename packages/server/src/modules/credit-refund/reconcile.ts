// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The daily refund reconcile (inner#1410 §7.2): every payment in scope has
 * its refunds read from Stripe and copied, so a webhook that never arrived
 * still lands within a day. Run from the refund loop's every tick; it decides
 * itself whether a pass is due, and one instance at a time runs it.
 */

import { db, env, getRedis, logger } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import * as reconcileRepo from "@server/modules/credit-refund/reconcile.repo.js";
import { sendOperationMailsLater } from "@server/modules/credit-refund/refund-mail.js";
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import { StripeReadError, listRefundsForPayment } from "@server/modules/credit-refund/stripe-refunds.js";

/**
 * How long the lock keeps other instances out. It is left to expire rather
 * than deleted: a pass that outlived it may run beside another, which only
 * copies the same refunds twice, and deleting would free a lock that by then
 * belongs to the other instance.
 */
const LOCK_SECONDS = 600;

/**
 * Run a pass when one is due and this instance gets the lock.
 * @param isStopped - Whether the refund loop was stopped meanwhile: no further payment is read.
 * @returns Once the pass, if any, has been recorded.
 */
export async function runDailyReconcile(isStopped: () => boolean = () => false): Promise<void> {
  if (!(await reconcileRepo.isDue())) return;
  const lockKey = `${env.ENV}:server:refund-reconcile-lock`;
  const locked = await getRedis().set(lockKey, "1", "EX", LOCK_SECONDS, "NX");
  if (locked === null) return;
  await reconcileRepo.markStarted();
  const failing: string[] = [];
  let lastError: string | null = null;
  for (const paymentId of await reconcileRepo.listPaymentsInScope(getCreditRefundConfig().reconcileWindowDays)) {
    // Left unfinished, the pass stays due and runs again in full.
    if (isStopped()) return;
    try {
      await reconcilePayment(paymentId);
    } catch (err) {
      failing.push(paymentId);
      lastError = `payment ${paymentId}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(
        { err, ...(err instanceof StripeReadError && { failure: err.failure }), paymentId },
        "refund_reconcile_payment_failed",
      );
    }
  }
  await reconcileRepo.markFinished(failing, lastError);
}

/**
 * Copy what Stripe holds for one payment.
 * @param paymentId - The payment.
 * @throws {Error} When the payment is missing or Stripe cannot be read.
 */
async function reconcilePayment(paymentId: string): Promise<void> {
  const listed = await listRefundsForPayment(paymentId);
  const judged = await db.transaction((tx) => applyRefundSnapshot(tx, paymentId, listed, "reconcile"));
  if (judged !== null) sendOperationMailsLater(judged);
}
