// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a Stripe subscription into the row we store (task #106, §5.2;
 * periods and the price check added in #253 §1.2).
 *
 * Pure: it takes an object Stripe handed back and returns what to write. No
 * database, no network, no logging — the caller decides what to do with a
 * subscription this cannot read.
 *
 * Four facts live here, and getting any of them wrong fails quietly:
 *
 *   - The paid period is on the ITEM, not on the subscription. Stripe moved it
 *     in the 2025-03-31 release; the old place returns undefined, which would
 *     leave the lapsed-subscription check (§10.1) permanently unable to fire.
 *   - The offer comes from the price the item sells. Nothing Stripe sends
 *     carries our word for a tier, and nothing carries our word for a billing
 *     period either. One lookup answers both.
 *   - An unpaid upgrade and an unpaid renewal both leave an open invoice. They
 *     are different situations offering different actions, so the pending
 *     change is read from its own field rather than inferred from the invoice.
 *   - What Stripe charges is compared against what our own price list says.
 *     The two are two copies of one figure on purpose: a price id pasted into
 *     the wrong slot, or an amount edited at Stripe, makes them differ, and
 *     that difference is the only thing that can show it.
 */

import type Stripe from "stripe";
import { findOfferByPriceId, getSubscriptionPlan } from "@breatic/core";
import type { SubscriptionWrite } from "@breatic/core";
import type { BillingPeriod } from "@breatic/shared";

/** What we expected Stripe to be charging, from our own price list. */
export interface ExpectedPrice {
  /** The amount, in the smallest currency unit. */
  readonly cents: number;
  /** ISO 4217 code, lower case, as Stripe writes it. */
  readonly currency: string;
  /** The period slot this price sits in for us. */
  readonly interval: BillingPeriod;
}

/**
 * What Stripe says it is charging.
 *
 * Every field is nullable: an unexpanded price is a bare id string, and there
 * is nothing on it to read.
 */
export interface ActualPrice {
  /** The amount Stripe charges, or null when the price was not expanded. */
  readonly cents: number | null;
  /** The currency Stripe charges in, or null. */
  readonly currency: string | null;
  /** How often Stripe bills, verbatim — it may be a word we do not sell. */
  readonly interval: string | null;
}

/**
 * What reading one Stripe subscription produced.
 *
 * Three answers rather than a row-or-null, because "I cannot place this
 * price" and "I can place it and the money disagrees" call for different
 * things from every caller. Collapsed into one, the caller that reads absence
 * as "already applied" tells somebody their change went through while the row
 * still holds the old plan.
 */
export type SubscriptionRead =
  | { readonly ok: true; readonly write: SubscriptionWrite }
  | { readonly ok: false; readonly reason: "priceUnknown" }
  | {
      readonly ok: false;
      readonly reason: "priceDisagreement";
      readonly expected: ExpectedPrice;
      readonly actual: ActualPrice;
    };

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
 * Reads what Stripe says it charges for one item.
 * @param item - One subscription item.
 * @returns The three figures, each null when the price was not expanded.
 */
function actualPriceOf(item: Stripe.SubscriptionItem | undefined): ActualPrice {
  const price = item?.price;
  if (!price || typeof price === "string") {
    return { cents: null, currency: null, interval: null };
  }
  return {
    cents: price.unit_amount ?? null,
    currency: price.currency ?? null,
    interval: price.recurring?.interval ?? null,
  };
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
 * @param subscription - The subscription object, ideally with `latest_invoice`
 *   and the item's `price` expanded.
 * @param userId - The account it belongs to, already resolved by the caller.
 * @param observedAt - When this snapshot was taken from Stripe. Passed in
 *   rather than read from the clock here, because the moment that matters is
 *   when the caller ASKED, not when it got round to writing.
 * @returns The row to write, or which of the two ways this reading failed.
 * @throws {Error} When the price list is missing or malformed.
 */
export function readStripeSubscription(
  subscription: Stripe.Subscription,
  userId: string,
  observedAt: Date = new Date(),
): SubscriptionRead {
  const item = subscription.items?.data?.[0];
  const priceId = priceIdOf(item);
  const offer = priceId ? findOfferByPriceId(priceId) : null;
  if (!item || !offer) return { ok: false, reason: "priceUnknown" };

  // The offer says which of our plans this price is supposed to be. What
  // Stripe charges for it has to be the same three figures.
  const plan = getSubscriptionPlan(offer.tier, offer.period);
  const expected: ExpectedPrice = {
    cents: plan.priceCents,
    currency: plan.currency,
    interval: offer.period,
  };
  const actual = actualPriceOf(item);
  if (
    actual.cents !== expected.cents ||
    actual.currency !== expected.currency ||
    actual.interval !== expected.interval
  ) {
    return { ok: false, reason: "priceDisagreement", expected, actual };
  }

  const pending = subscription.pending_update;
  const pendingOffer = (() => {
    const id = priceIdOf(pending?.subscription_items?.[0]);
    return id ? findOfferByPriceId(id) : null;
  })();
  const periodEnd = item.current_period_end;

  return {
    ok: true,
    write: {
      userId,
      stripeSubscriptionId: subscription.id,
      tier: offer.tier,
      period: offer.period,
      // No narrowing needed: the SDK's own status union is the same eight
      // words, which is what makes ours a copy rather than a guess.
      status: subscription.status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      stripeItemId: item.id,
      hasPendingUpdate: pending !== null && pending !== undefined,
      pendingTier: pendingOffer?.tier ?? null,
      pendingPeriod: pendingOffer?.period ?? null,
      payableInvoiceUrl: payableUrlOf(subscription.latest_invoice),
      observedAt,
    },
  };
}
