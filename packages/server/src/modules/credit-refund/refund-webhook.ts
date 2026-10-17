// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three refund events on the Stripe webhook (inner#1410 §7.3). The
 * event only says which payment changed: every refund of that payment is
 * read from Stripe and copied, so the order events arrive in does not matter.
 */

import { db, logger } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import { followUpOperationLater } from "@server/modules/credit-refund/refund-follow-up.js";
import { applyRefundSnapshot } from "@server/modules/credit-refund/refund-snapshot.js";
import { StripeReadError, listRefunds } from "@server/modules/credit-refund/stripe-refunds.js";
import type { StripeRefundObject } from "@server/modules/credit-refund/types.js";
import * as paymentRepo from "@server/modules/payment/payment.repo.js";
import { claimWebhookEvent } from "@server/modules/subscription/webhook-events.repo.js";

/** The event types handled here. */
export const REFUND_EVENT_TYPES: ReadonlySet<string> = new Set([
  "refund.created",
  "refund.updated",
  "refund.failed",
]);

/** A refund event as the webhook verified it. */
export interface RefundEvent {
  id: string;
  type: string;
  data: { object: { payment_intent?: string | { id: string } | null } };
}

/**
 * Handle one refund event.
 * @param event - The verified event.
 * @returns `unreadable` when Stripe could not be read and nothing was
 *   written, so Stripe should redeliver; `handled` otherwise.
 */
export async function handleRefundEvent(event: RefundEvent): Promise<"handled" | "unreadable"> {
  const intent = event.data.object.payment_intent;
  const paymentIntent = typeof intent === "string" ? intent : (intent?.id ?? null);
  const paymentId = paymentIntent ? await paymentRepo.findIdByPaymentIntent(paymentIntent) : null;
  const lotId = paymentId ? await creditLotRepo.findLotIdByPayment(paymentId) : null;
  if (paymentIntent === null || paymentId === null || lotId === null) {
    await db.transaction((tx) => claimWebhookEvent(event.id, event.type, tx));
    return "handled";
  }

  let listed: StripeRefundObject[];
  try {
    listed = await listRefunds(paymentIntent);
  } catch (err) {
    if (err instanceof StripeReadError) {
      logger.error(
        { err, failure: err.failure, eventId: event.id, type: event.type },
        "refund_webhook_stripe_unreadable",
      );
      return "unreadable";
    }
    throw err;
  }
  const judged = await db.transaction(async (tx) => {
    await creditLotRepo.lockLot(lotId, tx);
    // A redelivery is claimed once, but what it read is still copied (§6.4).
    await claimWebhookEvent(event.id, event.type, tx);
    return applyRefundSnapshot(tx, paymentId, listed, "webhook");
  });
  if (judged !== null) followUpOperationLater(judged);
  return "handled";
}
