// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import {
  CONSENT_DATA_FIELDS,
  parseConsentChoices,
  parseConsentCookie,
} from "../analytics/consent-choices.js";
import { CONSENT_MAX_AGE_DAYS, CONSENT_REVISION, NO_CONSENT } from "../analytics/consent.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function analyticsData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { decidedAt: iso(NOW - DAY), source: "banner", ...over };
}

function adsData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { decidedAt: iso(NOW - DAY), source: "banner", ...over };
}

function cookie(
  categories: string[],
  data: { analytics?: unknown; ads?: unknown } = { analytics: analyticsData(), ads: adsData() },
  revision: number = CONSENT_REVISION,
): string {
  return encodeURIComponent(JSON.stringify({ categories: ["necessary", ...categories], revision, data }));
}

describe("parseConsentChoices", () => {
  it("reads each category's latest choice", () => {
    expect(parseConsentChoices(cookie(["analytics"]), NOW)).toEqual({
      analytics: { value: true, source: "banner", decidedAt: iso(NOW - DAY), revision: CONSENT_REVISION },
      ads: { value: false, source: "banner", decidedAt: iso(NOW - DAY), revision: CONSENT_REVISION },
    });
  });

  it("reads nothing from a missing or corrupt cookie", () => {
    const none = { analytics: null, ads: null };
    expect(parseConsentChoices(undefined, NOW)).toEqual(none);
    expect(parseConsentChoices("not-json", NOW)).toEqual(none);
    expect(parseConsentChoices(encodeURIComponent("[1]"), NOW)).toEqual(none);
  });

  it("reads an entry that carries fields it does not know by its value", () => {
    const parsed = parseConsentChoices(cookie(["ads"], { ads: adsData({ legacyId: "1", legacyNotice: "gpc" }) }), NOW);
    expect(parsed.ads).toEqual({ value: true, source: "banner", decidedAt: iso(NOW - DAY), revision: CONSENT_REVISION });
  });

  it("treats a category whose data is missing or unreadable as unset", () => {
    expect(parseConsentChoices(cookie(["analytics", "ads"], {}), NOW)).toEqual({ analytics: null, ads: null });
    expect(parseConsentChoices(cookie(["ads"], { ads: adsData({ decidedAt: "yesterday" }) }), NOW).ads).toBeNull();
    expect(parseConsentChoices(cookie(["ads"], { ads: adsData({ source: "cookie-wall" }) }), NOW).ads).toBeNull();
  });

  it("reads a GPC entry as the refusal it always is, whatever the categories say", () => {
    expect(parseConsentChoices(cookie(["ads"], { ads: adsData({ source: "gpc" }) }), NOW).ads).toMatchObject({
      value: false,
      source: "gpc",
    });
  });

  it("expires each category on its own decidedAt", () => {
    const old = iso(NOW - (CONSENT_MAX_AGE_DAYS + 1) * DAY);
    const parsed = parseConsentChoices(
      cookie(["analytics", "ads"], { analytics: analyticsData({ decidedAt: old }), ads: adsData() }),
      NOW,
    );
    expect(parsed.analytics).toBeNull();
    expect(parsed.ads).toMatchObject({ value: true });
  });

  it("keeps analytics on its own time after a GPC rewrite of ads", () => {
    const parsed = parseConsentChoices(
      cookie(["analytics"], {
        analytics: analyticsData({ decidedAt: iso(NOW - (CONSENT_MAX_AGE_DAYS - 1) * DAY) }),
        ads: adsData({ source: "gpc", decidedAt: iso(NOW) }),
      }),
      NOW + 2 * DAY,
    );
    expect(parsed.analytics).toBeNull();
    expect(parsed.ads).toMatchObject({ value: false, source: "gpc" });
  });

  it("keeps an ads refusal across a revision change and past 395 days, and drops everything else", () => {
    const old = iso(NOW - 1000 * DAY);
    const parsed = parseConsentChoices(
      cookie(["analytics"], { analytics: analyticsData(), ads: adsData({ decidedAt: old }) }, CONSENT_REVISION - 1),
      NOW,
    );
    expect(parsed.analytics).toBeNull();
    expect(parsed.ads).toMatchObject({ value: false, decidedAt: old, revision: CONSENT_REVISION - 1 });
    expect(parseConsentChoices(cookie(["ads"], undefined, CONSENT_REVISION - 1), NOW).ads).toBeNull();
  });

  it("names the data fields both repos write", () => {
    expect(CONSENT_DATA_FIELDS).toEqual({
      analytics: ["decidedAt", "source"],
      ads: ["decidedAt", "source"],
    });
  });
});

describe("parseConsentCookie", () => {
  it("is the browser's own value per category, unset meaning off", () => {
    expect(parseConsentCookie(cookie(["analytics", "ads"]), NOW)).toEqual({ analytics: true, ads: true });
    expect(parseConsentCookie(cookie(["analytics"], { analytics: analyticsData() }), NOW)).toEqual({
      analytics: true,
      ads: false,
    });
    expect(parseConsentCookie(undefined, NOW)).toEqual(NO_CONSENT);
  });

  it("switches off a consent past 395 days", () => {
    const old = iso(NOW - (CONSENT_MAX_AGE_DAYS + 1) * DAY);
    const data = { analytics: analyticsData({ decidedAt: old }), ads: adsData({ decidedAt: old }) };
    expect(parseConsentCookie(cookie(["analytics", "ads"], data), NOW)).toEqual(NO_CONSENT);
  });

  it("keeps a choice made under a newer revision, as the browser does", () => {
    expect(parseConsentCookie(cookie(["analytics"], undefined, CONSENT_REVISION + 1), NOW)).toEqual({
      analytics: true,
      ads: false,
    });
  });
});

