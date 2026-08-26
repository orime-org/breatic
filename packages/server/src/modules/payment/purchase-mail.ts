// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The purchase confirmation email, and the record of whether it went out.
 *
 * Sending never holds the request. All four callers of `fulfillPayment` have
 * something waiting behind them — the webhook owes Stripe a prompt 2xx, the
 * confirmation endpoint has a buyer behind a full-screen wait, and reconciling
 * sits on the gate seven sections of the credits overlay share — so a stalled
 * SMTP connection would be felt by a person in every case. The send is started
 * and the answer goes out; the outbox row records what happened.
 *
 * Every state except `sent` offers a resend, because the question that decides
 * it is whether the letter went out, and only `sent` says it did. The claim
 * from the current state to `sending` is what makes five taps send one letter.
 */

import { sendMail } from "@breatic/core";
import * as outbox from "@server/modules/payment/purchase-mail.repo.js";

/**
 * The mail states a resend may start from.
 *
 * `pending` belongs here: a process replaced between the fulfillment
 * transaction committing and the first send claiming `sending` leaves the row
 * there, with no background sweep to free it, and this screen is the only
 * reader. `skipped` belongs here too — it is what every purchase lands on
 * while no mail backend is configured, which is the default in both env
 * templates.
 */
const RESENDABLE = ["pending", "sending", "failed", "skipped"] as const;

/**
 * Send the confirmation for one purchase, and record the outcome.
 *
 * Never throws: the credits are already granted, and a purchase does not
 * become undone because a letter did not leave. What the caller gets back is
 * whether it went out, and the row says the same thing for the screen that
 * offers the resend.
 * @param input - Which purchase, and where to write.
 * @param input.paymentId - The purchase this confirmation is about.
 * @param input.to - The buyer's address.
 * @param input.subject - The subject line, already in the buyer's language.
 * @param input.html - The HTML body.
 * @param input.text - The plain-text body.
 * @returns Whether the letter went out.
 */
export async function sendPurchaseConfirmation(input: {
  paymentId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  if (!(await outbox.claimSend(input.paymentId, RESENDABLE))) return false;
  try {
    const result = await sendMail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (result.status === "sent") {
      await outbox.recordSend(input.paymentId, "sent");
      return true;
    }
    // Console and disabled backends never put a letter on the wire, so the
    // row says so and keeps offering the resend for once one is configured.
    await outbox.recordSend(input.paymentId, "skipped");
    return false;
  } catch (err) {
    await outbox.recordSend(
      input.paymentId,
      "failed",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
