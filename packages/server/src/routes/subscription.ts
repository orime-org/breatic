// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The membership subscription endpoints (task #106, §7).
 *
 * Translation layer only: which path a click takes — start a subscription or
 * change the one that exists — is decided by `subscription.service` from state
 * this side reads, never by the request.
 *
 * All four answer `404` where payments are switched off, so a self-hosted
 * install has no subscription surface at all rather than one that fails
 * halfway through.
 */

import { Hono } from "hono";
import { env, logger, NotFoundError } from "@breatic/core";
import { requireAuth } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@server/middleware/validate.js";
import {
  subscriptionChangeSchema,
  subscriptionPlanSchema,
  t,
} from "@breatic/shared";
import * as subscriptionService from "@server/modules/subscription/subscription.service.js";

const subscription = new Hono<{ Variables: AuthVariables }>();

subscription.use(requireAuth);

// Every endpoint below reaches Stripe on every call, and Stripe's rate limit
// belongs to us as a whole rather than to the account spending it. Applied
// once here rather than per route: the four are the same kind of action, and a
// per-route list is a place for the fifth one to be forgotten.
subscription.use(rateLimitFor("subscription-write", "user"));

/**
 * Refuses every endpoint here when this deployment sells nothing.
 *
 * A `404` rather than a `403`: on a self-hosted install these endpoints do not
 * exist as a feature, and saying "forbidden" would imply they might work for
 * somebody else.
 * @throws {NotFoundError} when payments are switched off.
 */
function requirePayments(): void {
  if (!env.PAYMENT_ENABLED) {
    throw new NotFoundError(t("server.membership.unavailable"));
  }
}

/**
 * `POST /account/subscription/checkout` — start paying for a membership.
 *
 * For an account that holds none, including one whose previous subscription
 * ended: an ended subscription cannot be revived, so a returning customer
 * comes back through here.
 */
subscription.post(
  "/checkout",
  validate("json", subscriptionPlanSchema),
  async (c) => {
    requirePayments();
    const user = c.get("user");
    const body = c.req.valid("json");
    const result = await subscriptionService.startCheckout({
      userId: user.id,
      tier: body.tier,
      returnUrl: body.return_url,
    });
    logger.info(
      { userId: user.id, tier: body.tier },
      "subscription_checkout_started",
    );
    return c.json({ data: result });
  },
);

/**
 * `POST /account/subscription/change` — move an existing membership up a tier.
 *
 * Replaces the price on the subscription that exists. Moving down is refused:
 * no entrance offers it.
 */
subscription.post(
  "/change",
  validate("json", subscriptionChangeSchema),
  async (c) => {
    requirePayments();
    const user = c.get("user");
    const body = c.req.valid("json");
    const result = await subscriptionService.changePlan({
      userId: user.id,
      tier: body.tier,
    });
    logger.info(
      { userId: user.id, tier: body.tier, status: result.status },
      "subscription_plan_changed",
    );
    return c.json({ data: result });
  },
);

/**
 * `POST /account/subscription/cancel` — stop the membership renewing.
 *
 * Takes effect at the end of the paid period. Nothing is refunded and nothing
 * is taken away early.
 */
subscription.post("/cancel", async (c) => {
  requirePayments();
  const user = c.get("user");
  await subscriptionService.cancel(user.id);
  logger.info({ userId: user.id }, "subscription_cancelled");
  return c.json({ data: { ok: true } });
});

/**
 * `POST /account/subscription/resume` — take back a scheduled cancellation.
 *
 * The way out of a cancellation for somebody who changed their mind before the
 * period ended; without it they would have to wait for the plan to lapse and
 * subscribe again.
 */
subscription.post("/resume", async (c) => {
  requirePayments();
  const user = c.get("user");
  await subscriptionService.resume(user.id);
  logger.info({ userId: user.id }, "subscription_resumed");
  return c.json({ data: { ok: true } });
});

export { subscription as subscriptionRoute };
