// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type Stripe from "stripe";
import { logger } from "@breatic/core";
import type { StripeWebhookResult } from "@breatic/shared";
import { stripeWebhookRecordingService } from "@server/modules";
import type { AuthVariables } from "@server/middleware/auth.js";
import type { WebhookIdentity } from "@server/modules/stripe-webhook/types.js";

export interface StripeWebhookVariables {
  stripeWebhookEvent: Stripe.Event;
  stripeWebhookIdentity: WebhookIdentity;
  stripeWebhookReceivedAt: Date;
  stripeWebhookResult: StripeWebhookResult;
}

/**
 * Acknowledges the start before business and records the response after Hono maps errors.
 * @param c - The request carrying verified identity.
 * @param next - The existing business handler.
 * @returns The begin failure response, or control to the existing response.
 * @throws {Error} If the downstream HTTP error boundary itself fails.
 */
export const recordStripeWebhook: MiddlewareHandler<{ Variables: AuthVariables & StripeWebhookVariables }> = async (c, next): Promise<Response | void> => {
  const id = randomUUID();
  const identity = c.get("stripeWebhookIdentity");
  const context = { attemptId: id, eventId: identity.eventId, type: identity.eventType };
  try {
    await stripeWebhookRecordingService.startWebhookAttempt(id, identity, c.get("stripeWebhookReceivedAt"));
  } catch (err) {
    logger.error({ err, ctx: { ...context, stage: "begin" } }, "stripe_webhook_record_failed");
    return c.json({ received: false }, 503);
  }
  await next();
  if (c.error !== undefined) {
    logger.error({ err: c.error, ctx: { ...context, stage: "handler", responseStatus: c.res.status } }, "stripe_webhook_handler_failed");
  }
  try {
    await stripeWebhookRecordingService.finishWebhookAttempt(id, c.res.status, c.error === undefined ? c.get("stripeWebhookResult") : "handler_exception");
  } catch (err) {
    logger.error({ err, ctx: { ...context, stage: "finish" } }, "stripe_webhook_record_failed");
  }
};
