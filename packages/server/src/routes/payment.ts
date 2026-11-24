// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Credit purchase routes (inner#1993 §3.2): the billing service takes the
 * payment; these keep the web paths, auth, rate limits and body checks, and
 * hand each request to the user's endpoint there. Purchase history is
 * answered here, from the product's own lots merged with the payments the
 * billing service has not granted yet.
 */

import { Hono } from "hono";
import { validate } from "@breatic/core";
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
import { requireSelling } from "@server/middleware/require-selling.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { takeCheckoutSnapshot } from "@server/modules/analytics/checkout-snapshot.js";
import { userPath } from "@server/modules/commerce/commerce-client.js";
import { readPurchaseHistory } from "@server/modules/commerce/purchase-history.service.js";
import { forwardToCommerce, idempotencyKeyOf } from "@server/routes/commerce-forward.js";

const payment = new Hono<{ Variables: AuthVariables }>();

/** `GET /payment/tiers` — the credit packs on offer. */
payment.get("/tiers", requireAuth, requireSelling, async (c) =>
  forwardToCommerce(c, { method: "GET", path: userPath(c.get("user").id, "/payment/tiers"), quick: true }),
);

/** `POST /payment/checkout` — open a checkout for a credit pack. */
payment.post(
  "/checkout",
  requireAuth,
  requireSelling,
  rateLimitFor("payment-checkout", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", checkoutSchema),
  runOnce("credits-checkout"),
  async (c) => {
    const userId = c.get("user").id;
    return forwardToCommerce(c, {
      method: "POST",
      path: userPath(userId, "/payment/checkout"),
      body: { ...c.req.valid("json"), checkoutSnapshot: await takeCheckoutSnapshot(userId) },
      ...idempotencyKeyOf(c.req.valid("header")),
    });
  },
);

/**
 * `POST /payment/confirm` — the buyer is back from a payment. The billing
 * service grants it through the product before it answers, so the credits
 * are there when the page reads them.
 */
payment.post(
  "/confirm",
  requireAuth,
  requireSelling,
  rateLimitFor("payment-confirm", "user"),
  validate("json", paymentConfirmSchema),
  async (c) => forwardToCommerce(c, { method: "POST", path: userPath(c.get("user").id, "/payment/confirm"), body: c.req.valid("json") }),
);

/** `POST /payment/cancel` — the buyer pressed Back on the payment page. */
payment.post(
  "/cancel",
  requireAuth,
  requireSelling,
  rateLimitFor("payment-cancel", "user"),
  validate("json", paymentCancelSchema),
  async (c) => forwardToCommerce(c, { method: "POST", path: userPath(c.get("user").id, "/payment/cancel"), body: c.req.valid("json") }),
);

/**
 * `GET /payment/history` — how this account came by its credits, newest
 * first. A deployment that sells nothing answers its own lots only.
 */
payment.get("/history", requireAuth, validate("query", paymentHistoryQuerySchema), async (c) => {
  const { limit, cursor } = c.req.valid("query");
  return c.json({ data: await readPurchaseHistory(c.get("user").id, limit, cursor) });
});

/** `POST /payment/:id/resend-confirmation` — send that purchase's letter again. */
payment.post(
  "/:id/resend-confirmation",
  requireAuth,
  requireSelling,
  rateLimitFor("payment-resend", "user"),
  validate("param", idParamSchema),
  async (c) =>
    forwardToCommerce(c, { method: "POST", path: userPath(c.get("user").id, `/payment/${c.req.valid("param").id}/resend-confirmation`) }),
);

/** `GET /payment/:id` — one purchase. */
payment.get("/:id", requireAuth, requireSelling, validate("param", idParamSchema), async (c) =>
  forwardToCommerce(c, { method: "GET", path: userPath(c.get("user").id, `/payment/${c.req.valid("param").id}`) }),
);

export { payment as paymentRoute };
