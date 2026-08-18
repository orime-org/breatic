// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Payment routes - Stripe Checkout, webhooks, tiers, and history.
 *
 * The webhook endpoint skips authentication; Stripe signature
 * verification is handled via `verifyWebhookSignature()`.
 * All other endpoints require a valid session token.
 */

import { Hono } from "hono";
import { validate } from "@server/middleware/validate.js";
import { checkoutSchema, paginationSchema } from "@server/routes/schemas.js";
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
    const result = await paymentService.createCheckout(
      user.id,
      body.tier,
      body.success_url,
      body.cancel_url,
    );
    // Audit log moved from payment.service.ts per CLAUDE.md
    // "core and shared must not log" mandate (2026-05-27 PR
    // `feat/2026-05-27-collab-infra-resilience`).
    logger.info(
      { userId: user.id, tier: body.tier, paymentId: result.paymentId },
      "payment_checkout_session_created",
    );
    return c.json({ data: result }, 201);
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
    case "checkout.session.completed": {
      const outcome = await paymentService.handleCheckoutCompleted(
        session.id,
        typeof session.payment_intent === "string" ? session.payment_intent : undefined,
      );
      // Audit log moved from payment.service.ts (17B mandate).
      // The discriminated outcome distinguishes the at-most-once
      // CAS replay path from the real credit grant.
      if (outcome.status === "replay") {
        logger.info(
          { stripeSessionId: session.id },
          "payment_webhook_replay",
        );
      } else {
        logger.info(
          {
            userId: outcome.userId,
            credits: outcome.creditsGranted,
            newBalance: outcome.newBalance,
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
