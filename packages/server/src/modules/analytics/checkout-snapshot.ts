// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an order remembers about the browser that placed it (inner#1442
 * design §4.4.5, §4.4.7): that browser's consent and the ad click its account
 * was credited to. A purchase finishes in a webhook or a later visit with no
 * cookie of that browser, so the order carries both from checkout.
 */

import { adClickFrom, type AdClick, type ConsentSnapshot } from "@breatic/shared";
import { currentConsent, getAccountAttribution } from "@breatic/core";

/** The consent and click an order was placed under. */
export interface CheckoutSnapshot {
  readonly consent: ConsentSnapshot;
  readonly click: AdClick | null;
}

/**
 * Take the snapshot for an order placed in the current request. The click is
 * kept whatever the consent: it stays with Stripe as our processor, and
 * whether it is uploaded is decided when the conversion is queued.
 * @param userId - The buyer.
 * @returns The request's consent and the account's click.
 */
export async function takeCheckoutSnapshot(userId: string): Promise<CheckoutSnapshot> {
  const click = adClickFrom(await getAccountAttribution(userId), Date.now());
  return { consent: currentConsent(), click };
}

