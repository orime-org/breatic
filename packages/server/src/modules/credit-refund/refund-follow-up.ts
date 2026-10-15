// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a committed disposition reports beyond the buyer's mails (inner#1442
 * design §4.8, §4.9). A disposition that booked the refund, the only ones that
 * record `settled_succeeded_cents`, restates the ad conversion to zero and
 * sends `refund_completed` under the account's last seen choice, each on its
 * own; the ads sweep asks again for a restatement this misses. Credits
 * restored take back a restatement that never went out; one already queued or
 * sent is only logged, since the platform cannot undo a restatement to zero.
 */

import { accountOnlyConsent, cancelPendingAdsRestatement, enqueueAdsRestatement, logger, trackServerEvent } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import { sendOperationMailsLater } from "@server/modules/credit-refund/refund-mail.js";
import { runAfterReply } from "@server/utils/after-reply.js";

/**
 * Report what a committed disposition did.
 * @param operationId - The disposition.
 */
export async function reportRefundOutcome(operationId: string): Promise<void> {
  const op = await operationRepo.findById(operationId);
  if (op === null || op.status !== "succeeded") return;
  if (op.settledSucceededCents !== null) await reportRefunded(op, op.settledSucceededCents);
  else if (op.kind === "restore_credits") await noteRestored(op.paymentId);
}

/**
 * Restate the order's ad conversion to zero and send `refund_completed`. A
 * failure of one does not stop the other.
 * @param op - The disposition that booked the refund.
 * @param amountCents - What it settled.
 */
async function reportRefunded(op: CreditRefundOperation, amountCents: number): Promise<void> {
  try {
    if ((await enqueueAdsRestatement(op.paymentId)) === "consent_withdrawn") {
      logger.info({ paymentId: op.paymentId }, "ads_restatement_skipped_consent_withdrawn");
    }
  } catch (err) {
    logger.error({ err, paymentId: op.paymentId }, "ads_restatement_enqueue_failed");
  }
  try {
    await sendRefundCompleted(op, amountCents);
  } catch (err) {
    logger.error({ err, operationId: op.id }, "refund_completed_failed");
  }
}

/**
 * Send `refund_completed` under the account's last seen choice.
 * @param op - The disposition that booked the refund.
 * @param amountCents - What it settled.
 */
async function sendRefundCompleted(op: CreditRefundOperation, amountCents: number): Promise<void> {
  const [lot, paid] = await Promise.all([creditLotRepo.findLotById(op.lotId), paymentRepo.readPaidAmount(op.paymentId)]);
  if (lot === null || paid === null) return;
  trackServerEvent(
    "refund_completed",
    {
      userId: lot.userId,
      insertId: `refund:${lot.id}`,
      properties: { credits: Number(lot.purchasedCredits), amount_cents: amountCents, currency: paid.currency },
    },
    await accountOnlyConsent(lot.userId),
  );
}

/**
 * Take back a restatement that never went out for an order whose credits were
 * restored, and log one that cannot be.
 * @param paymentId - The order.
 */
async function noteRestored(paymentId: string): Promise<void> {
  const status = await cancelPendingAdsRestatement(paymentId);
  if (status === "restating" || status === "restated") logger.warn({ paymentId, status }, "ads_restatement_irreversible");
}

/**
 * Everything a disposition does once it committed, without holding the
 * caller: the buyer's mails, then what it reports. Every path that commits a
 * disposition calls this, so none of them can send the mails and skip the
 * report. Registered as after-reply work, so a shutdown waits for it.
 * @param operationId - The disposition.
 */
export function followUpOperationLater(operationId: string): void {
  sendOperationMailsLater(operationId);
  runAfterReply({ task: "refund_report", operationId }, () => reportRefundOutcome(operationId));
}
