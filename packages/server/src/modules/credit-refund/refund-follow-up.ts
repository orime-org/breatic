// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a committed disposition reports beyond the buyer's mails (inner#1442
 * design §4.8, §4.9): a disposition that booked the refund, the only kind
 * that records `settled_succeeded_cents`, sends `refund_completed` under the
 * account's latest reported consent. The ad conversion is left as uploaded.
 */

import { accountOnlyConsent, logger, trackServerEvent } from "@breatic/core";
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
  if (op === null || op.status !== "succeeded" || op.settledSucceededCents === null) return;
  try {
    await sendRefundCompleted(op, op.settledSucceededCents);
  } catch (err) {
    logger.error({ err, operationId: op.id }, "refund_completed_failed");
  }
}

/**
 * Send `refund_completed` under the account's latest reported consent.
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
