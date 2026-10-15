// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a committed disposition reports beyond the buyer's mails (inner#1442
 * design §4.8, §4.9). A disposition that booked the refund, the only ones that
 * record `settled_succeeded_cents`, sends `refund_completed` under the
 * account's last seen choice and restates the ad conversion to zero. Credits
 * restored after such a restatement are only logged: the platform cannot undo
 * a restatement to zero.
 */

import {
  accountOnlyConsent,
  enqueueAdsRestatement,
  findUploadByPayment,
  logger,
  trackServerEvent,
  type AdsUploadStatus,
} from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import { sendOperationMailsLater } from "@server/modules/credit-refund/refund-mail.js";
import { runAfterReply } from "@server/utils/after-reply.js";

/** Upload states in which a restatement to zero was sent or will be. */
const RESTATED: ReadonlySet<AdsUploadStatus> = new Set(["restate_pending", "restating", "restated"]);

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
 * Send `refund_completed` and restate the order's ad conversion to zero.
 * @param op - The disposition that booked the refund.
 * @param amountCents - What it settled.
 */
async function reportRefunded(op: CreditRefundOperation, amountCents: number): Promise<void> {
  const [lot, paid] = await Promise.all([creditLotRepo.findLotById(op.lotId), paymentRepo.readPaidAmount(op.paymentId)]);
  if (lot !== null && paid !== null) {
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
  if ((await enqueueAdsRestatement(op.paymentId)) === "consent_withdrawn") {
    logger.info({ paymentId: op.paymentId }, "ads_restatement_skipped_consent_withdrawn");
  }
}

/**
 * Log credits restored on an order whose conversion was restated to zero.
 * @param paymentId - The order.
 */
async function noteRestored(paymentId: string): Promise<void> {
  const upload = await findUploadByPayment(paymentId);
  if (upload !== null && RESTATED.has(upload.status)) {
    logger.warn({ paymentId, status: upload.status }, "ads_restatement_irreversible");
  }
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
