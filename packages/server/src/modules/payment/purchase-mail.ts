// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The purchase confirmation email, and the record of whether it went out.
 *
 * Sending never holds the request. All four callers of `fulfillPayment` have
 * something waiting behind them — the webhook owes Stripe a prompt 2xx, the
 * confirmation endpoint has a buyer behind a full-screen wait, cancelling has
 * one looking at a dialog, and reconciling sits on the gate seven sections of
 * the credits overlay share — so a stalled SMTP connection would be felt by a
 * person in every case. The send is started and the answer goes out; the
 * outbox row records what happened.
 *
 * Every state except `sent` offers a resend, because the question that decides
 * it is whether the letter went out, and only `sent` says it did. The claim
 * from the current state to `sending` is what makes five taps send one letter.
 */

import { sendMail } from "@breatic/core";
import * as outbox from "@server/modules/payment/purchase-mail.repo.js";

/**
 * Send the confirmation for one purchase, and record the outcome.
 *
 * Nothing the mail backend does reaches the caller: the credits are already
 * granted, and a purchase does not become undone because a letter did not
 * leave. What comes back is whether it went out, and the row says the same
 * thing for the screen that offers the resend. The two writes to the outbox
 * are outside that — a database this cannot reach is the caller's to answer
 * for.
 * @param input - Which purchase, where to write, and when a send in flight
 *   stops counting as one.
 * @param input.paymentId - The purchase this confirmation is about.
 * @param input.to - The buyer's address.
 * @param input.subject - The subject line, already in the buyer's language.
 * @param input.html - The HTML body.
 * @param input.text - The plain-text body.
 * @param input.staleSendingBefore - A send claimed before this instant is
 *   treated as abandoned, so its row can be claimed again.
 * @returns Whether the letter went out.
 */
export async function sendPurchaseConfirmation(input: {
  paymentId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  staleSendingBefore: Date;
}): Promise<boolean> {
  const claim = await outbox.claimSend(
    input.paymentId,
    input.staleSendingBefore,
  );
  if (claim === null) return false;

  // Only the send is guarded. With the write inside the guard too, a database
  // that blinks while recording a letter that DID go out sends the failure
  // down the same path, and the row ends up saying `failed` about a letter the
  // buyer is holding — which is what puts the resend button back in front of
  // them.
  let outcome: { status: "sent" | "skipped" } | { status: "failed"; error: string };
  try {
    const result = await sendMail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    // Console and disabled backends never put a letter on the wire, so the row
    // says so and keeps offering the resend for once one is configured.
    outcome =
      result.status === "sent" ? { status: "sent" } : { status: "skipped" };
  } catch (err) {
    outcome = {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await outbox.recordSend(
    input.paymentId,
    claim,
    outcome.status,
    outcome.status === "failed" ? outcome.error : undefined,
  );
  return outcome.status === "sent";
}
