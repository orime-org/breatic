// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether ads may run and what a signed-in browser reports to the account
 * (inner#1442 design §4.4.5, §4.4.6): the browser's own choice decides; GPC
 * only refuses ads the visitor never chose; events with no browser use the
 * account's latest report.
 */

import { describe, it, expect } from "vitest";
import { CONSENT_REVISION } from "../analytics/consent.js";
import type { BrowserChoice } from "../analytics/consent-choices.js";
import { adsAllowed, browserAdsConsent } from "../analytics/ads-consent.js";

const choice = (value: boolean, source: BrowserChoice["source"]): BrowserChoice => ({
  value,
  source,
  decidedAt: new Date().toISOString(),
  revision: CONSENT_REVISION,
});

describe("browserAdsConsent", () => {
  it("is the browser's ads value without GPC", () => {
    expect(browserAdsConsent(choice(true, "implicit"), false)).toBe(true);
    expect(browserAdsConsent(choice(false, "banner"), false)).toBe(false);
    expect(browserAdsConsent(null, false)).toBe(false);
  });

  it("refuses a regional default under GPC, and keeps the visitor's own consent", () => {
    expect(browserAdsConsent(choice(true, "implicit"), true)).toBe(false);
    expect(browserAdsConsent(null, true)).toBe(false);
    expect(browserAdsConsent(choice(true, "banner"), true)).toBe(true);
    expect(browserAdsConsent(choice(true, "settings"), true)).toBe(true);
  });
});

describe("adsAllowed", () => {
  it("follows the browser when there is one", () => {
    expect(adsAllowed({ browser: { consent: true } })).toBe(true);
    expect(adsAllowed({ browser: { consent: false }, seen: { value: true, revision: CONSENT_REVISION } })).toBe(false);
  });

  it("follows the account's latest report when no browser caused the event", () => {
    expect(adsAllowed({ browser: null, seen: { value: true, revision: CONSENT_REVISION } })).toBe(true);
    expect(adsAllowed({ browser: null, seen: { value: false, revision: CONSENT_REVISION } })).toBe(false);
    expect(adsAllowed({ browser: null, seen: null })).toBe(false);
    expect(adsAllowed({ browser: null, seen: { value: true, revision: CONSENT_REVISION - 1 } })).toBe(false);
  });

  it("never allows a deleted account", () => {
    expect(adsAllowed({ browser: { consent: true }, deleted: true })).toBe(false);
    expect(adsAllowed({ browser: null, seen: { value: true, revision: CONSENT_REVISION }, deleted: true })).toBe(false);
  });
});
