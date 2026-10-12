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
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import { listRefunds } from "@server/modules/credit-refund/stripe-refunds.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";

/** Longer than any pass takes; a crashed holder's lock expires by itself. */
const LOCK_SECONDS = 600;

/**
 * Run a pass when one is due and this instance gets the lock.
 * @returns Once the pass, if any, has been recorded.
 */
export async function runDailyReconcile(): Promise<void> {
  if (!(await reconcileRepo.isDue())) return;
  const lockKey = `${env.ENV}:server:refund-reconcile-lock`;
  const locked = await getRedis().set(lockKey, "1", "EX", LOCK_SECONDS, "NX");
  if (locked === null) return;
  try {
    await reconcileRepo.markStarted();
    const failing: string[] = [];
    let lastError: string | null = null;
    for (const paymentId of await reconcileRepo.listPaymentsInScope(getCreditRefundConfig().reconcileWindowDays)) {
      try {
        await reconcilePayment(paymentId);
      } catch (err) {
        failing.push(paymentId);
        lastError = `payment ${paymentId}: ${err instanceof Error ? err.message : String(err)}`;
        logger.error({ err, paymentId }, "refund_reconcile_payment_failed");
      }
    }
    await reconcileRepo.markFinished(failing, lastError);
  } finally {
    await getRedis().del(lockKey);
  }
}

/**
 * Copy what Stripe holds for one payment.
 * @param paymentId - The payment.
 * @throws {Error} When the payment or its intent is missing, or Stripe cannot be read.
 */
async function reconcilePayment(paymentId: string): Promise<void> {
  const payment = await paymentRepo.getPaymentById(paymentId);
  if (!payment?.stripePaymentIntentId) throw new Error("no payment intent to read");
  const listed = await listRefunds(payment.stripePaymentIntentId);
  await db.transaction((tx) => applyRefundSnapshot(tx, paymentId, listed));
}
