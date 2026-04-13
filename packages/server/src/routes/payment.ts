/**
 * Payment routes — Stripe Checkout, webhooks, tiers, and history.
 *
 * The webhook endpoint skips authentication; Stripe signature
 * verification is handled via `verifyWebhookSignature()`.
 * All other endpoints require a valid session token.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { checkoutSchema, paginationSchema } from "./schemas.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import { paymentService } from "@breatic/core";
import { verifyWebhookSignature } from "@breatic/core";
import { logger } from "@breatic/core";

const payment = new Hono<{ Variables: AuthVariables }>();

/**
 * `GET /payment/tiers` — list available credit purchase tiers.
 *
 * Public pricing info for the frontend (no auth required).
 */
payment.get("/tiers", async (c) => {
  const tiers = paymentService.listTiers();
  return c.json(tiers);
});

/** `POST /payment/checkout` — create a Stripe Checkout session. */
payment.post(
  "/checkout",
  requireAuth,
  zValidator("json", checkoutSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const result = await paymentService.createCheckout(
      user.id,
      body.tier,
      body.success_url,
      body.cancel_url,
    );
    return c.json(result, 201);
  },
);

/**
 * `POST /payment/webhook` — Stripe webhook receiver.
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

  const session = event.data.object as { id: string; payment_intent?: string };

  switch (event.type) {
    case "checkout.session.completed":
      await paymentService.handleCheckoutCompleted(
        session.id,
        typeof session.payment_intent === "string" ? session.payment_intent : undefined,
      );
      break;
    case "checkout.session.async_payment_failed":
      await paymentService.handlePaymentFailed(session.id);
      break;
    default:
      break;
  }

  return c.json({ received: true });
});

/** `GET /payment/history` — list the authenticated user's payments. */
payment.get(
  "/history",
  requireAuth,
  zValidator("query", paginationSchema),
  async (c) => {
    const user = c.get("user");
    const { limit, offset } = c.req.valid("query");
    const list = await paymentService.listPayments(user.id, limit, offset);
    return c.json(list);
  },
);

/** `GET /payment/:id` — get a single payment by ID. */
payment.get("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const result = await paymentService.getPayment(id, user.id);
  return c.json(result);
});

export { payment as paymentRoute };
