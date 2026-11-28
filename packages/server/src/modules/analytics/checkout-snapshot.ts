// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What an order remembers about the browser that placed it (inner#1442
 * design §4.4.5, §4.4.7): that browser's consent and the ad click its account
 * was credited to. A purchase finishes in a webhook or a later visit with no
 * cookie of that browser, so the order carries both from checkout. It also
 * carries the influencer the account signed up under (inner#2157), which the
 * billing service records on the payment for revenue share.
 */

import { adClickFrom, type AdClick, type ConsentSnapshot } from "@breatic/shared";
import { currentConsent, getAccountAttribution } from "@breatic/core";
import { getUserById } from "@server/modules/auth/user.repo.js";
import { OFFICIAL_INFLUENCER } from "@server/modules/auth/influencer-code.js";

/** The consent and click an order was placed under. */
export interface CheckoutSnapshot {
  readonly consent: ConsentSnapshot;
  readonly click: AdClick | null;
  readonly influencer: string;
}

/**
 * Take the snapshot for an order placed in the current request. The click is
 * kept whatever the consent: it stays with Stripe as our processor, and
 * whether it is uploaded is decided when the conversion is queued.
 * @param userId - The buyer.
 * @returns The request's consent, the account's click and its influencer.
 * @throws {Error} When the account cannot be read.
 */
export async function takeCheckoutSnapshot(userId: string): Promise<CheckoutSnapshot> {
  const [attribution, user] = await Promise.all([getAccountAttribution(userId), getUserById(userId)]);
  const click = adClickFrom(attribution, Date.now());
  return { consent: currentConsent(), click, influencer: user?.influencerCode ?? OFFICIAL_INFLUENCER };
}

