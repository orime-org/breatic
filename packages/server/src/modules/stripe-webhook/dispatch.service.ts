// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type Stripe from "stripe";
import { logger } from "@breatic/core";
import type { StripeWebhookResult } from "@breatic/shared";
import { REFUND_EVENT_TYPES, handleRefundEvent, type RefundEvent } from "@server/modules/credit-refund/refund-webhook.js";
import { handleSubscriptionEvent, type SubscriptionEventOutcome } from "@server/modules/subscription/subscription-events.js";
import { fulfillPayment, handlePaymentFailed, type FulfillOutcome } from "@server/modules/payment/payment.service.js";
import { logFulfillment } from "@server/modules/payment/fulfillment-log.js";
import type { WebhookDispatch } from "@server/modules/stripe-webhook/types.js";

const CREDIT_RESULTS = {
  granted: "credits_granted", replay: "credits_replay", noop: "credits_noop", expired: "credits_expired", failed: "credits_payment_failed", mismatch: "credits_mismatch", unknown: "credits_unknown",
} as const satisfies Record<FulfillOutcome["status"], StripeWebhookResult>;
const MEMBERSHIP_RESULTS = {
  applied: "membership_applied", replay: "membership_replay", acknowledged: "membership_acknowledged", priceDisagreement: "membership_price_disagreement",
} as const satisfies Record<Exclude<SubscriptionEventOutcome["status"], "noop" | "notMine">, StripeWebhookResult>;
const MEMBERSHIP_NOOP_RESULTS = {
  no_account: "membership_no_account", unknown_price: "membership_unknown_price", no_subscription: "membership_no_subscription",
} as const satisfies Record<Extract<SubscriptionEventOutcome, { status: "noop" }>["reasonCode"], StripeWebhookResult>;

/**
 * Dispatches the existing business paths and retains their protocol response.
 * @param event - The verified event passed by the HTTP boundary.
 * @returns Its finite processing result and existing response fields.
 * @throws {Error} When a business dependency fails; the HTTP error handler maps it.
 */
export async function dispatchStripeWebhook(event: Stripe.Event): Promise<WebhookDispatch> {
  const membership = await handleSubscriptionEvent(event);
  if (membership.status !== "notMine") {
    const line = { eventId: event.id, type: event.type, ...membership };
    if (membership.status === "priceDisagreement") logger.error(line, "subscription_price_disagreement");
    else if (membership.status === "noop") logger.warn(line, "subscription_webhook_handled");
    else logger.info(line, "subscription_webhook_handled");
    const result = membership.status === "noop" ? MEMBERSHIP_NOOP_RESULTS[membership.reasonCode] : MEMBERSHIP_RESULTS[membership.status];
    return { result, responseStatus: membership.status === "priceDisagreement" ? 500 : 200, received: membership.status !== "priceDisagreement" };
  }
  if (REFUND_EVENT_TYPES.has(event.type)) {
    const refund = await handleRefundEvent(event as unknown as RefundEvent);
    const results = { synced: "refund_synced", no_target: "refund_no_target", unreadable: "refund_unreadable" } as const;
    return { result: results[refund], responseStatus: refund === "unreadable" ? 500 : 200, received: refund !== "unreadable" };
  }
  const session = event.data.object as { id: string };
  let credit: FulfillOutcome;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.expired":
      credit = await fulfillPayment(session.id, { id: event.id, type: event.type });
      break;
    case "checkout.session.async_payment_failed":
      credit = await handlePaymentFailed(session.id);
      break;
    default:
      return { result: "ignored", responseStatus: 200, received: true };
  }
  logFulfillment(credit, { stripeSessionId: session.id, from: "webhook" });
  return { result: CREDIT_RESULTS[credit.status], responseStatus: 200, received: true };
}
