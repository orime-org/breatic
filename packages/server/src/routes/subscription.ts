// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The membership subscription endpoints (inner#1993 §3.2): the billing
 * service holds the Stripe subscription; these keep the web paths, auth,
 * rate limit and body checks and hand each request to the user's endpoint
 * there. All answer 404 where nothing is sold.
 */

import { Hono } from "hono";
import { adsAllowedFor, currentAdsBrowser, logger, subscriptionConfirmAnswerSchema, validate } from "@breatic/core";
import { requireAuth } from "@server/middleware/auth.js";
import { requireSellingMemberships } from "@server/middleware/require-selling.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { runOnce } from "@server/middleware/run-once.js";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";
import { paymentConfirmSchema, subscriptionChangeSchema, subscriptionPlanSchema } from "@breatic/shared";
import { readAccountMembership } from "@server/modules/account/membership.service.js";
import { takeCheckoutSnapshot } from "@server/modules/analytics/checkout-snapshot.js";
import { userPath } from "@server/modules/commerce/commerce-client.js";
import { sendPendingReferralBinding } from "@server/modules/commerce/commerce-relay.js";
import { callCommerceOrAnswer, forwardToCommerce, idempotencyKeyOf } from "@server/routes/commerce-forward.js";

const subscription = new Hono<{ Variables: AuthVariables }>();

subscription.use(requireAuth);
subscription.use(requireSellingMemberships);
// Every endpoint below reaches Stripe through the billing service, and
// Stripe's rate limit belongs to us as a whole.
subscription.use(rateLimitFor("subscription-write", "user"));

/**
 * `POST /account/subscription/checkout` — start paying for a membership. It
 * sends the account's pending referral binding to the billing service first,
 * since the checkout reads it for the first-period discount.
 */
subscription.post(
  "/checkout",
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", subscriptionPlanSchema),
  runOnce("membership"),
  async (c) => {
    const userId = c.get("user").id;
    await sendPendingReferralBinding(userId);
    return forwardToCommerce(c, {
      method: "POST",
      path: userPath(userId, "/subscription/checkout"),
      body: { ...c.req.valid("json"), checkoutSnapshot: await takeCheckoutSnapshot(userId) },
      ...idempotencyKeyOf(c.req.valid("header")),
    });
  },
);

/** `POST /account/subscription/change` — move an existing membership up. */
subscription.post(
  "/change",
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", subscriptionChangeSchema),
  runOnce("membership"),
  async (c) =>
    forwardToCommerce(c, {
      method: "POST",
      path: userPath(c.get("user").id, "/subscription/change"),
      body: c.req.valid("json"),
      ...idempotencyKeyOf(c.req.valid("header")),
    }),
);

/** `POST /account/subscription/cancel` — stop the membership renewing. */
subscription.post("/cancel", async (c) => forwardToCommerce(c, { method: "POST", path: userPath(c.get("user").id, "/subscription/cancel") }));

/** `POST /account/subscription/resume` — take back a scheduled cancellation. */
subscription.post("/resume", async (c) => forwardToCommerce(c, { method: "POST", path: userPath(c.get("user").id, "/subscription/resume") }));

/**
 * `POST /account/subscription/confirm` — the buyer is back from a membership
 * checkout. The billing service has stored the subscription through the
 * product before it answers, so the panel read here shows the tier bought.
 * @returns `200` with the membership panel and, when ads may run for this
 *   account and browser, the ad conversion the page reports (inner#1442 §4.9).
 */
subscription.post("/confirm", validate("json", paymentConfirmSchema), async (c) => {
  const userId = c.get("user").id;
  const result = await callCommerceOrAnswer(c, { method: "POST", path: userPath(userId, "/subscription/confirm"), body: c.req.valid("json") });
  if ("response" in result) return result.response;
  const candidate = subscriptionConfirmAnswerSchema.parse(result.answer.body).data.conversion;
  const membership = await readAccountMembership(userId);
  let conversion: typeof candidate = null;
  // The subscription is already confirmed; a failed ads lookup only withholds the conversion.
  try {
    if (candidate !== null && (await adsAllowedFor(userId, currentAdsBrowser()))) conversion = candidate;
  } catch (err) {
    logger.error({ err, userId }, "ads_conversion_gate_failed");
  }
  return c.json({ data: { ...membership, conversion } });
});

export { subscription as subscriptionRoute };
