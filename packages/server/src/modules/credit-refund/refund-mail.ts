// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending the buyer emails about a refund (inner#1410 §6.5, §8). The bell is
 * the always-delivered half, written with the disposition; the email is the
 * best-effort half, sent from its outbox row after the disposition commits,
 * and by the refund loop's sweep for whatever that missed.
 *
 * Each row is claimed once and sent once. A resend is a new row; a send
 * nobody wrote back becomes `unknown` and stays there for the operator.
 */

import { logger, sendMail } from "@breatic/core";
import { getCreditRefundConfig } from "@server/config/credit-refund.js";
import * as refundMailRepo from "@server/modules/credit-refund/refund-mail.repo.js";
import { renderRefundMail } from "@server/modules/credit-refund/refund-mail-template.js";
import { runAfterReply } from "@server/utils/after-reply.js";

/** Rows the loop's sweep sends per tick; the rest wait for the next. */
const SWEEP_BATCH = 50;

/**
 * Send one row's letter and record where it landed.
 * @param mailId - The outbox row.
 * @returns Whether the letter went out.
 */
export async function sendRefundMail(mailId: string): Promise<boolean> {
  if (!(await refundMailRepo.claimSend(mailId))) return false;
  const view = await refundMailRepo.getMailView(mailId);
  const letter = await renderRefundMail(view!);

  // Only the send is guarded: a write-back that fails must not be recorded
  // as a failed send of a letter the buyer already has.
  let outcome: { status: "sent" | "skipped" } | { status: "failed"; error: string };
  try {
    const result = await sendMail({
      to: letter.to,
      subject: letter.subject,
      html: letter.html,
      text: letter.text,
    });
    // Console and disabled backends put nothing on the wire.
    outcome = result.status === "sent" ? { status: "sent" } : { status: "skipped" };
  } catch (err) {
    outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  const recorded = await refundMailRepo.recordSend(
    mailId,
    outcome.status,
    outcome.status === "failed" ? outcome.error : undefined,
  );
  if (!recorded) {
    logger.warn({ mailId, outcome: outcome.status }, "refund_mail_late_write_back_discarded");
  }
  return outcome.status === "sent";
}

/**
 * Send a disposition's waiting rows right after it committed, without
 * holding the caller: a mail backend that fails changes nothing it answers.
 * Registered as after-reply work, so a shutdown waits for it.
 * @param operationId - The disposition.
 */
export function sendOperationMailsLater(operationId: string): void {
  runAfterReply({ task: "refund_mail", operationId }, async () => {
    for (const mailId of await refundMailRepo.listPendingOf(operationId)) {
      await sendRefundMail(mailId);
    }
  });
}

/**
 * Send one row right after its request committed, without holding the
 * caller; registered as after-reply work.
 * @param mailId - The outbox row.
 */
export function sendRefundMailLater(mailId: string): void {
  runAfterReply({ task: "refund_mail", mailId }, async () => {
    await sendRefundMail(mailId);
  });
}

/**
 * The loop's sweep (§7.1 step 3): rows still pending a minute after insert.
 * One row that fails does not stop the others.
 * @param isStopped - Whether the refund loop was stopped meanwhile: no further row is taken.
 * @returns Once every row of the batch has been tried.
 */
export async function sendDueRefundMails(isStopped: () => boolean = () => false): Promise<void> {
  for (const mailId of await refundMailRepo.listDuePending(SWEEP_BATCH)) {
    if (isStopped()) return;
    try {
      await sendRefundMail(mailId);
    } catch (err) {
      logger.error({ err, mailId }, "refund_mail_send_failed");
    }
  }
}

/**
 * Give up on sends nobody wrote back within `stale_sending_minutes` (M5).
 * @returns How many rows became `unknown`.
 */
export async function markStaleRefundMailsUnknown(): Promise<number> {
  const staleBefore = new Date(Date.now() - getCreditRefundConfig().staleSendingMinutes * 60_000);
  return refundMailRepo.markStaleUnknown(staleBefore);
}
