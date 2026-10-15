// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { NO_CONSENT, type BrowserAdsSnapshot } from "@breatic/shared";
import { readCheckoutSnapshot, toStripeMetadata } from "@server/modules/analytics/checkout-snapshot.js";

const CLICK = { gclid: "c1", at: "2026-10-12T01:00:00.000Z" };
const ADS_BROWSER: BrowserAdsSnapshot = { consent: true };
const UNSET: BrowserAdsSnapshot = { consent: false };

describe("checkout snapshot", () => {
  it("round-trips through Stripe metadata strings", () => {
    const snapshot = { consent: { analytics: true, ads: true }, adsBrowser: ADS_BROWSER, click: CLICK };
    const metadata = toStripeMetadata(snapshot);
    expect(Object.values(metadata).every((v) => v.length <= 500)).toBe(true);
    expect(readCheckoutSnapshot(metadata)).toEqual(snapshot);
  });

  it("reads the object form an order row stores", () => {
    expect(
      readCheckoutSnapshot({ analyticsConsent: { analytics: false, ads: true }, adsBrowser: ADS_BROWSER, adClick: CLICK }),
    ).toEqual({ consent: { analytics: false, ads: true }, adsBrowser: ADS_BROWSER, click: CLICK });
  });

  it("leaves the click out of Stripe metadata when there is none", () => {
    expect(toStripeMetadata({ consent: NO_CONSENT, adsBrowser: UNSET, click: null })).toEqual({
      analyticsConsent: JSON.stringify(NO_CONSENT),
      adsBrowser: JSON.stringify(UNSET),
    });
  });

  it("reads no consent, a browser with no ads choice and no click from missing or malformed metadata", () => {
    for (const metadata of [
      null,
      undefined,
      {},
      { analyticsConsent: "{oops", adsBrowser: "{oops", adClick: "x" },
      { analyticsConsent: { analytics: "yes" }, adsBrowser: { consent: "yes" } },
      { adsBrowser: { consent: true, extra: 1 } },
      // An order placed before this shape existed.
      { adsBrowser: { choice: null, gpcAt: null, at: "2026-10-12T02:00:00.000Z" } },
    ]) {
      expect(readCheckoutSnapshot(metadata as Record<string, unknown> | null)).toEqual({
        consent: NO_CONSENT,
        adsBrowser: UNSET,
        click: null,
      });
    }
  });

  it("drops a stored click without a click identifier", () => {
    expect(readCheckoutSnapshot({ adClick: { utm_source: "x", at: CLICK.at } }).click).toBeNull();
  });
});
