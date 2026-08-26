// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Payment routes - Stripe Checkout, webhooks, tiers, and history.
 *
 * The webhook endpoint skips authentication; Stripe signature
 * verification is handled via `verifyWebhookSignature()`.
 * All other endpoints require a valid session token.
 */

import { Hono } from "hono";
import { validate } from "@server/middleware/validate.js";
import {
  checkoutSchema,
  paymentConfirmSchema,
  paymentCancelSchema,
  paymentHistoryQuerySchema,
} from "@server/routes/schemas.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { requirePayments } from "@server/middleware/require-payments.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { paymentService } from "@server/modules";
import { logFulfillment } from "@server/modules/payment/fulfillment-log.js";
import { verifyWebhookSignature } from "@server/infra/stripe.js";
import { logger } from "@breatic/core";
import { handleSubscriptionEvent } from "@server/modules/subscription/subscription-events.js";

const payment = new Hono<{ Variables: AuthVariables }>();

/**
 * `GET /payment/tiers` — the credit packs on offer.
 *
 * Behind auth: the buy screen is inside the account.
 * @returns `200` with the packs.
 */
payment.get("/tiers", requireAuth, async (c) => {
  const tiers = paymentService.listTiers();
  return c.json({ data: tiers });
});

/** `POST /payment/checkout` - create a Stripe Checkout session. */
payment.post(
  "/checkout",
  requireAuth,
  requirePayments,
  rateLimitFor("payment-checkout", "user"),
  validate("json", checkoutSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const result = await paymentService.createCheckout({
      userId: user.id,
      priceCents: body.price_cents,
      returnUrl: body.return_url,
      timeZone: body.time_zone,
    });
    // Audit log moved from payment.service.ts per CLAUDE.md
    // "core and shared must not log" mandate (2026-05-27 PR
    // `feat/2026-05-27-collab-infra-resilience`).
    logger.info(
      { userId: user.id, priceCents: body.price_cents, paymentId: result.paymentId },
      "payment_checkout_session_created",
    );
    return c.json({ data: { url: result.url } }, 201);
  },
);

/**
 * `POST /payment/confirm` — the buyer is back from a payment.
 *
 * Settles the purchase there and then rather than waiting for the webhook,
 * because a buyer standing in front of a full-screen wait should see their
 * credits, not a spinner. The webhook still arrives and finds the work done.
 * @returns `200` with what settling it did; `404` when the session names no
 *   purchase of theirs.
 */
payment.post(
  "/confirm",
  requireAuth,
  requirePayments,
  rateLimitFor("payment-confirm", "user"),
  validate("json", paymentConfirmSchema),
  async (c) => {
    const user = c.get("user");
    const { session_id: sessionId } = c.req.valid("json");
    const outcome = await paymentService.confirmCheckout(user.id, sessionId);
    logFulfillment(outcome, {
      stripeSessionId: sessionId,
      from: "confirm",
      userId: user.id,
    });
    return c.json({ data: { status: outcome.status } });
  },
);

/**
 * `POST /payment/cancel` — the buyer pressed Back on the Stripe page.
 *
 * Expires the session so the purchase stops showing as in flight. Answers 200
 * even when Stripe could not be reached: nothing the buyer holds is harmed,
 * and reconciling picks the row up two minutes later.
 * @returns `200` with where the purchase now stands; `404` when it is not
 *   theirs.
 */
payment.post(
  "/cancel",
  requireAuth,
  requirePayments,
  rateLimitFor("payment-cancel", "user"),
  validate("json", paymentCancelSchema),
  async (c) => {
    const user = c.get("user");
    const { payment_id: paymentId } = c.req.valid("json");
    const result = await paymentService.cancelCheckout(user.id, paymentId);
    if (result.failure !== null) {
      // Answered 200 regardless: nothing the buyer holds is harmed, and
      // reconciling reaches this row two minutes later.
      logger.error(
        { err: result.failure, userId: user.id, paymentId },
        "payment_cancel_unsettled",
      );
    }
    return c.json({ data: { status: result.status } });
  },
);

/**
 * `POST /payment/webhook` - Stripe webhook receiver.
 *
 * No auth middleware. Verifies Stripe signature to prevent tampering.
 */
payment.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("stripe-signature") ?? "";

  let event;
  try {
    event = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    logger.warn({ err }, "Stripe webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 400);
  }

  // Subscriptions first: the membership leg has its own event types, its own
  // idempotency, and its own identification chain. It answers `notMine` only
  // for events that are genuinely the credit-pack leg's — including the
  // `checkout.session.completed` of a credit-pack session, which is the one
  // type both legs receive.
  const subscriptionOutcome = await handleSubscriptionEvent(event);
  if (subscriptionOutcome.status !== "notMine") {
    // A `noop` is logged at warn, not info: the two ways to reach it are an
    // account we cannot identify and a price this deployment does not sell,
    // and both mean somebody may have paid for something we did not record.
    // Everything else here is a normal event, `acknowledged` most of all —
    // one of those is what a successful membership checkout produces.
    //
    // Written as two calls rather than one through a variable holding the
    // method: pino's level methods live on the prototype and use `this`, so
    // `const log = logger.warn` hands back an unbound function that throws
    // `TypeError` the moment it is called. Every subscription event would
    // reach this line, throw after the database work had already been done,
    // and answer 500.
    const line = {
      eventId: event.id,
      type: event.type,
      ...subscriptionOutcome,
    };
    if (subscriptionOutcome.status === "noop") {
      logger.warn(line, "subscription_webhook_handled");
    } else {
      logger.info(line, "subscription_webhook_handled");
    }
    return c.json({ received: true });
  }

  const session = event.data.object as { id: string; payment_intent?: string };

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.expired": {
      const outcome = await paymentService.fulfillPayment(session.id, {
        id: event.id,
        type: event.type,
      });
      logFulfillment(outcome, { stripeSessionId: session.id, from: "webhook" });
      break;
    }
    case "checkout.session.async_payment_failed": {
      const outcome = await paymentService.handlePaymentFailed(session.id);
      logFulfillment(outcome, { stripeSessionId: session.id, from: "webhook" });
      break;
    }
    default:
      break;
  }

  return c.json({ received: true });
});

/**
 * `GET /payment/history` — every purchase this account has made.
 *
 * Includes the ones that have not landed and the ones the buyer abandoned:
 * this is the screen that answers "what happened to my money", and a purchase
 * with no credits behind it yet is exactly the case that needs answering.
 *
 * No deployment gate. An install that sells nothing still opens this screen
 * and shows an empty state, which is a thing to render rather than a 404.
 * @returns `200` with one keyset page.
 */
payment.get(
  "/history",
  requireAuth,
  validate("query", paymentHistoryQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { limit, cursor } = c.req.valid("query");
    const data = await paymentService.getPurchaseHistory(user.id, limit, cursor);
    return c.json({ data });
  },
);

/**
 * `POST /payment/:id/resend-confirmation` — send that letter again.
 *
 * Offered from the purchase history when the first send did not go out. The
 * outbox claim is what makes five taps one letter.
 * @returns `200` with whether a letter went out; `404` when the purchase is
 *   not theirs.
 */
payment.post(
  "/:id/resend-confirmation",
  requireAuth,
  requirePayments,
  rateLimitFor("payment-resend", "user"),
  async (c) => {
    const user = c.get("user");
    const paymentId = c.req.param("id");
    const sent = await paymentService.resendConfirmation(user.id, paymentId);
    logger.info({ userId: user.id, paymentId, sent }, "purchase_mail_resent");
    return c.json({ data: { sent } });
  },
);

/** `GET /payment/:id` - get a single payment by ID. */
payment.get("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const result = await paymentService.getPayment(id, user.id);
  return c.json({ data: result });
});

export { payment as paymentRoute };
