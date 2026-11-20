// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A subscription's first activation for analytics and the ad platform
 * (inner#1442 design §4.8, §4.9). The billing service decides the start and
 * sends what it reports with the subscription fact (inner#1993 §3.3); it is
 * reported here after the fact commits.
 */

import { enqueueAdsConversion, logger, trackServerEvent } from "@breatic/core";
import type { SubscriptionStarted } from "@breatic/core";

/**
 * Report a subscription's first activation, after the write that stamped it committed.
 * @param userId - The account.
 * @param started - What the start reports.
 */
export function reportSubscriptionStarted(userId: string, started: SubscriptionStarted): void {
  const { properties, consent, click, transactionId } = started;
  trackServerEvent(
    "subscription_started",
    {
      userId,
      insertId: transactionId,
      properties: { tier: properties.tier, interval: properties.interval, amount_cents: properties.amountCents, currency: properties.currency },
    },
    consent,
  );
  enqueueAdsConversion(
    {
      userId,
      conversion: "subscription",
      transactionId,
      click,
      value: { amountCents: properties.amountCents, currency: properties.currency },
    },
    { consent: consent.ads },
  ).catch((err: unknown) => {
    logger.error({ err, userId, transactionId }, "ads_conversion_enqueue_failed");
  });
}
