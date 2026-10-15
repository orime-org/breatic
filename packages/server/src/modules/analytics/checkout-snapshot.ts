// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an order remembers about the browser that placed it (inner#1442
 * design §4.4.5, §4.4.7): that browser's consent, the ads side of it that
 * `adsAllowed` weighs with the account's events, and the ad click its account
 * was credited to. A purchase finishes in a webhook or a later visit with no
 * cookie of that browser, so the order carries all three from checkout.
 */

import {
  adClickFrom,
  BrowserAdsSnapshotSchema,
  NO_ADS_BROWSER,
  NO_CONSENT,
  type AdClick,
  type BrowserAdsSnapshot,
  type ConsentSnapshot,
} from "@breatic/shared";
import { currentAdsBrowser, currentConsent, getAccountAttribution } from "@breatic/core";

/** The consent and click an order was placed under. */
export interface CheckoutSnapshot {
  readonly consent: ConsentSnapshot;
  readonly adsBrowser: BrowserAdsSnapshot;
  readonly click: AdClick | null;
}

/** A browser with no ads choice: what a missing or unreadable snapshot stands for. */

/**
 * Take the snapshot for an order placed in the current request. The click is
 * kept whatever the consent: it stays with Stripe as our processor, and
 * whether it is uploaded is decided when the conversion is queued.
 * @param userId - The buyer.
 * @returns The request's consent and the account's click.
 */
export async function takeCheckoutSnapshot(userId: string): Promise<CheckoutSnapshot> {
  const click = adClickFrom(await getAccountAttribution(userId), Date.now());
  return { consent: currentConsent(), adsBrowser: currentAdsBrowser(), click };
}

/**
 * The snapshot as Stripe metadata, whose values are strings of at most 500 characters.
 * @param snapshot - The snapshot.
 * @returns Metadata entries to merge into a Checkout Session or subscription.
 */
export function toStripeMetadata(snapshot: CheckoutSnapshot): Record<string, string> {
  return {
    analyticsConsent: JSON.stringify(snapshot.consent),
    adsBrowser: JSON.stringify(snapshot.adsBrowser),
    ...(snapshot.click ? { adClick: JSON.stringify(snapshot.click) } : {}),
  };
}

/**
 * Read a snapshot back from order metadata or Stripe metadata.
 * @param metadata - `payments.metadata` (objects) or Stripe metadata (JSON strings).
 * @returns The snapshot; no consent, a browser with no ads choice and no click
 *   when absent or unreadable.
 */
export function readCheckoutSnapshot(metadata: Record<string, unknown> | null | undefined): CheckoutSnapshot {
  const consent = parseField(metadata?.analyticsConsent);
  const adsBrowser = BrowserAdsSnapshotSchema.safeParse(parseField(metadata?.adsBrowser));
  const click = parseField(metadata?.adClick);
  return {
    consent:
      typeof consent?.analytics === "boolean" && typeof consent.ads === "boolean"
        ? { analytics: consent.analytics, ads: consent.ads }
        : NO_CONSENT,
    adsBrowser: adsBrowser.success ? adsBrowser.data : NO_ADS_BROWSER,
    click: typeof click?.at === "string" && hasClickId(click) ? (click as unknown as AdClick) : null,
  };
}

/**
 * Accept a stored object or its JSON text.
 * @param value - Either form, or anything else.
 * @returns The object, or null.
 */
function parseField(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/**
 * Whether a stored click carries one of Google's click identifiers.
 * @param click - The parsed click.
 * @returns True when gclid, gbraid or wbraid is a string.
 */
function hasClickId(click: Record<string, unknown>): boolean {
  return ["gclid", "gbraid", "wbraid"].some((key) => typeof click[key] === "string");
}
