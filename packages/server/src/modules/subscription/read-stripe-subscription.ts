// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a Stripe subscription into the row we store (task #106, §5.2).
 *
 * Pure: it takes an object Stripe handed back and returns what to write. No
 * database, no network, no logging — the caller decides what to do with a
 * subscription this cannot read.
 *
 * Three facts live here, and getting any of them wrong fails quietly:
 *
 *   - The paid period is on the ITEM, not on the subscription. Stripe moved it
 *     in the 2025-03-31 release; the old place returns undefined, which would
 *     leave the lapsed-subscription check (§10.1) permanently unable to fire.
 *   - The tier comes from the price the item sells. Nothing Stripe sends
 *     carries our word for it.
 *   - An unpaid upgrade and an unpaid renewal both leave an open invoice. They
 *     are different situations offering different actions, so the pending
 *     upgrade is read from its own field rather than inferred from the invoice.
 */

import type Stripe from "stripe";
import { findSubscribableTierByPriceId } from "@breatic/core";
import type { SubscriptionWrite } from "@breatic/core";

/**
 * Reads the price id off a subscription item, however deeply it is expanded.
 * @param item - One subscription item.
 * @returns Its price id, or null.
 */
function priceIdOf(item: Stripe.SubscriptionItem | undefined): string | null {
  const price = item?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

/**
 * Reads the hosted payment page of an invoice that still needs paying.
 *
 * Null unless the invoice was expanded AND is still open: a link to a paid
 * invoice would put "finish paying" in front of somebody who is up to date,
 * and an unexpanded `latest_invoice` is a bare id string.
 * @param invoice - Whatever sits in `latest_invoice`.
 * @returns The hosted page, or null.
 */
function payableUrlOf(
  invoice: Stripe.Subscription["latest_invoice"],
): string | null {
  if (!invoice || typeof invoice === "string") return null;
  if (invoice.status !== "open") return null;
  return invoice.hosted_invoice_url ?? null;
}

/**
 * Reads what Stripe says about a subscription into the row we store.
 * @param subscription - The subscription object, ideally with
 *   `latest_invoice` expanded.
 * @param userId - The account it belongs to, already resolved by the caller.
 * @param observedAt - When this snapshot was taken from Stripe. Passed in
 *   rather than read from the clock here, because the moment that matters is
 *   when the caller ASKED, not when it got round to writing.
 * @returns What to write, or null when the subscription sells a price this
 *   deployment does not know — storing it under a guessed tier would hand out
 *   ceilings nobody bought.
 */
export function readStripeSubscription(
  subscription: Stripe.Subscription,
  userId: string,
  observedAt: Date = new Date(),
): SubscriptionWrite | null {
  const item = subscription.items?.data?.[0];
  const priceId = priceIdOf(item);
  const tier = priceId ? findSubscribableTierByPriceId(priceId) : null;
  if (!item || !tier) return null;

  const pending = subscription.pending_update;
  const pendingPriceId = priceIdOf(pending?.subscription_items?.[0]);
  const periodEnd = item.current_period_end;

  return {
    userId,
    stripeSubscriptionId: subscription.id,
    tier,
    // No narrowing needed: the SDK's own status union is the same eight
    // words, which is what makes ours a copy rather than a guess.
    status: subscription.status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    stripeItemId: item.id,
    hasPendingUpdate: pending !== null && pending !== undefined,
    pendingTier: pendingPriceId
      ? findSubscribableTierByPriceId(pendingPriceId)
      : null,
    payableInvoiceUrl: payableUrlOf(subscription.latest_invoice),
    observedAt,
  };
}
