// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the routing layer writes down about one fulfillment pass.
 *
 * Four callers reach `fulfillPayment` and three of them sit behind a route:
 * the webhook, the confirmation endpoint, and the reconcile pass the credits
 * overview runs. They answer their own callers differently and log the same
 * way, so the levels live here rather than at each of them.
 */

import { logger } from "@breatic/core";
import type { FulfillOutcome } from "@server/modules/payment/payment.service.js";

/**
 * Write down what one fulfillment pass did, at the level it deserves.
 *
 * Four of the six outcomes are ordinary traffic, and `replay` is the most
 * ordinary of all: the confirmation endpoint settles a purchase and Stripe's
 * own event arrives seconds later to find the work done, so every purchase
 * where the buyer came back promptly produces one. The two that mean money
 * moved without credits following it have to stand out from that, or nobody
 * will ever see them.
 *
 * Written as separate calls per level rather than one through a variable
 * holding the method: pino's level methods live on the prototype and use
 * `this`, so a detached reference throws the moment it is called.
 * @param outcome - What the pass did.
 * @param ctx - The session it was about, and which caller asked.
 * @param ctx.stripeSessionId - The Checkout Session.
 * @param ctx.from - Which of the four callers this was.
 * @param ctx.userId - The account, where the caller knows it.
 */
export function logFulfillment(
  outcome: FulfillOutcome,
  ctx: { stripeSessionId: string; from: string; userId?: string },
): void {
  switch (outcome.status) {
    case "granted":
      logger.info(
        {
          ...ctx,
          userId: outcome.userId,
          credits: outcome.creditsGranted,
          lotId: outcome.lotId,
        },
        "payment_credits_granted",
      );
      // Credits are granted either way: a paid session is paid. But this
      // purchase now has no record of what its buyer agreed to, which is what
      // a chargeback would be answered with.
      if (!outcome.consentRecorded) {
        logger.warn({ ...ctx }, "payment_consent_not_recorded");
      }
      return;
    case "mismatch":
      // The card was charged and the credits are withheld. Both figures go in
      // the line so the price table can be compared against Stripe without
      // opening either.
      logger.error(
        {
          ...ctx,
          expectedCents: outcome.expectedCents,
          chargedCents: outcome.chargedCents,
          expectedCurrency: outcome.expectedCurrency,
          chargedCurrency: outcome.chargedCurrency,
        },
        "payment_amount_mismatch",
      );
      return;
    case "unknown":
      // A paid session this deployment has no row for. With the membership
      // leg claiming its own events, nothing legitimate reaches here.
      logger.warn({ ...ctx }, "payment_session_not_ours");
      return;
    case "failed":
      // The card was refused after the fact. The buyer is told by their bank,
      // and the row now says so; nothing here has to be repaired.
      logger.info({ ...ctx }, "payment_failed");
      return;
    default:
      logger.info({ ...ctx, outcome: outcome.status }, "payment_no_grant");
  }
}
