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
  paginationSchema,
  paymentConfirmSchema,
  paymentCancelSchema,
} from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { paymentService } from "@server/modules";
import { verifyWebhookSignature } from "@server/infra/stripe.js";
import { logger } from "@breatic/core";
import { handleSubscriptionEvent } from "@server/modules/subscription/subscription-events.js";

const payment = new Hono<{ Variables: AuthVariables }>();

/**
 * `GET /payment/tiers` - list available credit purchase tiers.
 *
 * Public pricing info for the frontend (no auth required).
 */
payment.get("/tiers", async (c) => {
  const tiers = paymentService.listTiers();
  return c.json({ data: tiers });
});

/** `POST /payment/checkout` - create a Stripe Checkout session. */
payment.post(
  "/checkout",
  requireAuth,
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
  validate("json", paymentConfirmSchema),
  async (c) => {
    const user = c.get("user");
    const { session_id: sessionId } = c.req.valid("json");
    const outcome = await paymentService.confirmCheckout(user.id, sessionId);
    logger.info(
      { userId: user.id, sessionId, outcome: outcome.status },
      "payment_confirm_handled",
    );
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
  validate("json", paymentCancelSchema),
  async (c) => {
    const user = c.get("user");
    const { payment_id: paymentId } = c.req.valid("json");
    const result = await paymentService.cancelCheckout(user.id, paymentId);
    if (!result.stripeReachable) {
      logger.error(
        { userId: user.id, paymentId },
        "payment_cancel_stripe_unreachable",
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
      const outcome = await paymentService.fulfillPayment(session.id, event.id);
      // Audit log moved from payment.service.ts (17B mandate).
      // The discriminated outcome distinguishes the at-most-once
      // CAS replay path from the real credit grant.
      if (outcome.status !== "granted") {
        logger.info(
          { stripeSessionId: session.id, outcome: outcome.status },
          "payment_webhook_no_grant",
        );
      } else {
        logger.info(
          {
            userId: outcome.userId,
            credits: outcome.creditsGranted,
            lotId: outcome.lotId,
            stripeSessionId: session.id,
          },
          "payment_credits_granted",
        );
      }
      break;
    }
    case "checkout.session.async_payment_failed":
      await paymentService.handlePaymentFailed(session.id);
      logger.info({ stripeSessionId: session.id }, "payment_failed");
      break;
    default:
      break;
  }

  return c.json({ received: true });
});

/** `GET /payment/history` - list the authenticated user's payments. */
payment.get(
  "/history",
  requireAuth,
  validate("query", paginationSchema),
  async (c) => {
    const user = c.get("user");
    const { limit, offset } = c.req.valid("query");
    const list = await paymentService.listPayments(user.id, limit, offset);
    return c.json({ data: list });
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
