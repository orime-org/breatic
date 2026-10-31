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
import { runOnce } from "@server/middleware/run-once.js";
import {
  idempotencyKeyHeaderSchema,
  checkoutSchema,
  paymentConfirmSchema,
  paymentCancelSchema,
  paymentHistoryQuerySchema,
  idParamSchema,
} from "@server/routes/schemas.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { requirePayments } from "@server/middleware/require-payments.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { paymentService, stripeWebhookRecordingService, stripeWebhookDispatchService } from "@server/modules";
import { logFulfillment } from "@server/modules/payment/fulfillment-log.js";
import { verifyWebhookSignature } from "@server/infra/stripe.js";
import { logger } from "@breatic/core";
import { recordStripeWebhook, type StripeWebhookVariables } from "@server/middleware/stripe-webhook-recording.js";
import type Stripe from "stripe";

const payment = new Hono<{ Variables: AuthVariables }>();
const webhook = new Hono<{ Variables: AuthVariables & StripeWebhookVariables }>();

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
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", checkoutSchema),
  runOnce("credits-checkout"),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const result = await paymentService.createCheckout({
      userId: user.id,
      priceCents: body.price_cents,
      returnUrl: body.return_url,
      timeZone: body.time_zone,
    });
    // Audit log moved from payment.service.ts per
    // AGENTS.md#library-packages-do-not-log (2026-05-27 PR
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
 * @returns `200` with what settling it did, whether the order is paid
 *   whichever pass granted it, and its amount and currency (the page reports
 *   the ad conversion on `paid`, inner#1442 §4.9); `404` when the session names no purchase of theirs.
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
    const order = await paymentService.paidOrder(sessionId);
    return c.json({ data: { status: outcome.status, ...order } });
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
    if (result.settled !== null) {
      // Pressing Back on a session that had in fact been paid settles it here,
      // and no webhook or reconcile pass produces this outcome a second time.
      logFulfillment(result.settled.outcome, {
        stripeSessionId: result.settled.stripeSessionId,
        from: "cancel",
        userId: user.id,
      });
    }
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
webhook.post("/webhook", async (c, next) => {
  const receivedAt = new Date();
  const rawBody = await c.req.text();
  const signature = c.req.header("stripe-signature") ?? "";
  let event: Stripe.Event;
  try {
    event = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    logger.warn({ err }, "Stripe webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 400);
  }
  const identity = stripeWebhookRecordingService.parseWebhookIdentity(event);
  if (identity === null) {
    logger.warn({ stage: "identity" }, "stripe_webhook_shape_rejected");
    return c.json({ received: false }, 400);
  }
  c.set("stripeWebhookEvent", event);
  c.set("stripeWebhookIdentity", identity);
  c.set("stripeWebhookReceivedAt", receivedAt);
  await next();
}, recordStripeWebhook, async c => {
  const result = await stripeWebhookDispatchService.dispatchStripeWebhook(c.get("stripeWebhookEvent"));
  c.set("stripeWebhookResult", result.result);
  return c.json({ received: result.received }, result.responseStatus);
});
payment.route("/", webhook);

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
  validate("param", idParamSchema),
  async (c) => {
    const user = c.get("user");
    const { id: paymentId } = c.req.valid("param");
    const sent = await paymentService.resendConfirmation(user.id, paymentId);
    logger.info({ userId: user.id, paymentId, sent }, "purchase_mail_resent");
    return c.json({ data: { sent } });
  },
);

/** `GET /payment/:id` - get a single payment by ID. */
payment.get(
  "/:id",
  requireAuth,
  validate("param", idParamSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const result = await paymentService.getPayment(id, user.id);
    return c.json({ data: result });
  },
);

export { payment as paymentRoute };
