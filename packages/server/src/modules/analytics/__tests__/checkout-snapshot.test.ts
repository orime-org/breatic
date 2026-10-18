// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { NO_CONSENT } from "@breatic/shared";
import { readCheckoutSnapshot, toStripeMetadata } from "@server/modules/analytics/checkout-snapshot.js";

const CLICK = { gclid: "c1", at: "2026-10-12T01:00:00.000Z" };

describe("checkout snapshot", () => {
  it("round-trips through Stripe metadata strings", () => {
    const snapshot = { consent: { analytics: true, ads: true }, click: CLICK };
    const metadata = toStripeMetadata(snapshot);
    expect(Object.values(metadata).every((v) => v.length <= 500)).toBe(true);
    expect(readCheckoutSnapshot(metadata)).toEqual(snapshot);
  });

  it("reads the object form an order row stores", () => {
    expect(
      readCheckoutSnapshot({ analyticsConsent: { analytics: false, ads: true }, adClick: CLICK }),
    ).toEqual({ consent: { analytics: false, ads: true }, click: CLICK });
  });

  it("leaves the click out of Stripe metadata when there is none", () => {
    expect(toStripeMetadata({ consent: NO_CONSENT, click: null })).toEqual({
      analyticsConsent: JSON.stringify(NO_CONSENT),
    });
  });

  it("reads no consent and no click from missing or malformed metadata", () => {
    for (const metadata of [
      null,
      undefined,
      {},
      { analyticsConsent: "{oops", adClick: "x" },
      { analyticsConsent: { analytics: "yes" } },
    ]) {
      expect(readCheckoutSnapshot(metadata as Record<string, unknown> | null)).toEqual({
        consent: NO_CONSENT,
        click: null,
      });
    }
  });

  it("drops a stored click without a click identifier", () => {
    expect(readCheckoutSnapshot({ adClick: { utm_source: "x", at: CLICK.at } }).click).toBeNull();
  });
});
