// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Subscription starts and renewals for analytics and the ad platform
 * (inner#1442 design §4.8, §4.9). A start follows the consent the subscribing
 * browser left on the subscription's metadata; a renewal has no browser
 * behind it and follows the account's latest choice.
 */

import { enqueueAdsConversion, getSubscriptionPlan, logger, trackServerEvent } from "@breatic/core";
import type { SubscriptionWrite } from "@breatic/core";
import { SUBSCRIBABLE_MEMBERSHIP_TIERS, type SubscribableMembershipTier } from "@breatic/shared";
import { readCheckoutSnapshot } from "@server/modules/analytics/checkout-snapshot.js";
import { getAnalyticsConsent } from "@server/modules/auth/auth.service.js";

/**
 * The plan a stored subscription is on, for its price.
 * @param write - The stored snapshot.
 * @returns The event properties shared by start and renewal, or null for a tier with no plan.
 */
function planProperties(write: Pick<SubscriptionWrite, "tier" | "period">): Record<string, unknown> | null {
  if (!(SUBSCRIBABLE_MEMBERSHIP_TIERS as readonly string[]).includes(write.tier)) return null;
  const plan = getSubscriptionPlan(write.tier as SubscribableMembershipTier, write.period);
  return { tier: write.tier, interval: write.period, amount_cents: plan.priceCents, currency: plan.currency };
}

/**
 * Report a subscription's first activation, after the write that stamped it committed.
 * @param write - The stored snapshot.
 * @param metadata - The Stripe subscription's metadata, holding the checkout snapshot.
 */
export function reportSubscriptionStarted(write: SubscriptionWrite, metadata: Record<string, unknown> | null): void {
  const properties = planProperties(write);
  if (properties === null) return;
  const { consent, click } = readCheckoutSnapshot(metadata);
  const transactionId = `sub:${write.stripeSubscriptionId}`;
  trackServerEvent("subscription_started", { userId: write.userId, insertId: transactionId, properties }, consent);
  enqueueAdsConversion(
    {
      conversion: "subscription",
      transactionId,
      click,
      value: { amountCents: properties.amount_cents as number, currency: properties.currency as string },
    },
    consent,
  ).catch((err: unknown) => {
    logger.error({ err, userId: write.userId, transactionId }, "ads_conversion_enqueue_failed");
  });
}

/**
 * Report a paid renewal invoice.
 * @param input - The renewal.
 * @param input.eventId - Stripe's event id, the dedupe key.
 * @param input.userId - The account.
 * @param input.subscription - The account's stored subscription the invoice renews.
 */
export async function reportSubscriptionRenewed(input: {
  eventId: string;
  userId: string;
  subscription: Pick<SubscriptionWrite, "tier" | "period">;
}): Promise<void> {
  const properties = planProperties(input.subscription);
  if (properties === null) return;
  const consent = await getAnalyticsConsent(input.userId);
  if (consent === null) return;
  trackServerEvent("subscription_renewed", { userId: input.userId, insertId: input.eventId, properties }, consent);
}
