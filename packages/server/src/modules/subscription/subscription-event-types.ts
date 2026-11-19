// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Stripe event types the membership leg routes on. Kept apart from the
 * handlers so the dispatcher and the catch-up can name them without loading
 * the handlers.
 */

/**
 * The event types that say something about a subscription's state.
 *
 * `checkout.session.completed` is absent here but still claimed (`claimsEvent` in
 * `subscription-events.ts`) when its
 * session is a subscription one: it says the checkout flow finished, which is
 * not the same as the subscription being paid for — at that moment it may
 * still be `incomplete` — so there is nothing to do with it, and the state
 * arrives through `customer.subscription.*` instead.
 */
export const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
]);

/**
 * The Checkout Session events both legs receive.
 *
 * Every one of these arrives for a membership checkout and for a credit-pack
 * checkout alike, and nothing but the session's `mode` separates them. A
 * membership event that falls through to the credit leg looks up a `payments`
 * row that was never written: the failure branch answers the webhook 404, and
 * Stripe redelivers a 404 for three days.
 */
export const SHARED_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

/** A paid invoice: a renewal or a plan change landing (`handleInvoicePaid`). */
export const INVOICE_PAID_EVENT_TYPE = "invoice.paid";
