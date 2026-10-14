// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import {
  CONSENT_DATA_FIELDS,
  accountAnalyticsValue,
  parseConsentChoices,
  parseConsentCookie,
} from "../analytics/consent-choices.js";
import { CONSENT_MAX_AGE_DAYS, CONSENT_REVISION, NO_CONSENT } from "../analytics/consent.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function analyticsData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { decisionId: ID_A, decidedAt: iso(NOW - DAY), source: "banner", ...over };
}

function adsData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionId: ID_B,
    decidedAt: iso(NOW - DAY),
    source: "banner",
    noticeShown: false,
    gpcAtDecision: false,
    ...over,
  };
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
      analytics: { decisionId: ID_A, value: true, source: "banner", decidedAt: iso(NOW - DAY), revision: CONSENT_REVISION },
      ads: {
        decisionId: ID_B,
        value: false,
        source: "banner",
        noticeShown: false,
        gpcAtDecision: false,
        decidedAt: iso(NOW - DAY),
        revision: CONSENT_REVISION,
      },
    });
  });

  it("reads nothing from a missing or corrupt cookie", () => {
    const none = { analytics: null, ads: null };
    expect(parseConsentChoices(undefined, NOW)).toEqual(none);
    expect(parseConsentChoices("not-json", NOW)).toEqual(none);
    expect(parseConsentChoices(encodeURIComponent("[1]"), NOW)).toEqual(none);
  });

  it("reads a category without a decisionId by its value, and leaves the id out", () => {
    const parsed = parseConsentChoices(cookie(["analytics"], { analytics: analyticsData({ decisionId: undefined }) }), NOW);
    expect(parsed.analytics).toMatchObject({ value: true });
    expect(parsed.analytics).not.toHaveProperty("decisionId");
    expect(parseConsentChoices(cookie(["analytics"], { analytics: analyticsData({ decisionId: "x" }) }), NOW).analytics)
      .not.toHaveProperty("decisionId");
  });

  it("treats a category whose data is missing or unreadable as unset", () => {
    expect(parseConsentChoices(cookie(["analytics", "ads"], {}), NOW)).toEqual({ analytics: null, ads: null });
    expect(parseConsentChoices(cookie(["ads"], { ads: adsData({ decidedAt: "yesterday" }) }), NOW).ads).toBeNull();
    expect(parseConsentChoices(cookie(["ads"], { ads: adsData({ source: "cookie-wall" }) }), NOW).ads).toBeNull();
    expect(parseConsentChoices(cookie(["ads"], { ads: adsData({ noticeShown: "yes" }) }), NOW).ads).toBeNull();
    // A GPC entry is only ever a refusal; one that reads as a consent is not ours.
    expect(parseConsentChoices(cookie(["ads"], { ads: adsData({ source: "gpc" }) }), NOW).ads).toBeNull();
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

  it("reads the override fields of an ads choice", () => {
    const parsed = parseConsentChoices(
      cookie(["ads"], { ads: adsData({ source: "settings", noticeShown: "gpc", gpcAtDecision: true }) }),
      NOW,
    );
    expect(parsed.ads).toMatchObject({ value: true, source: "settings", noticeShown: "gpc", gpcAtDecision: true });
  });

  it("names the data fields both repos write", () => {
    expect(CONSENT_DATA_FIELDS).toEqual({
      analytics: ["decisionId", "decidedAt", "source"],
      ads: ["decisionId", "decidedAt", "source", "noticeShown", "gpcAtDecision"],
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

describe("accountAnalyticsValue", () => {
  const receipt = (value: boolean, daysAgo: number, revision = CONSENT_REVISION) => ({
    value,
    decidedAt: iso(NOW - daysAgo * DAY),
    revision,
  });

  it("is null with nothing on record", () => {
    expect(accountAnalyticsValue([], NOW)).toBeNull();
  });

  it("takes the latest receipt, in any order", () => {
    expect(accountAnalyticsValue([receipt(true, 1), receipt(false, 2)], NOW)).toBe(true);
    expect(accountAnalyticsValue([receipt(true, 2), receipt(false, 1)], NOW)).toBe(false);
  });

  it("takes the stricter of two receipts at the same instant", () => {
    expect(accountAnalyticsValue([receipt(true, 1), receipt(false, 1)], NOW)).toBe(false);
    expect(accountAnalyticsValue([receipt(false, 1), receipt(true, 1)], NOW)).toBe(false);
  });

  it("skips receipts past 395 days or from an older revision, consent or refusal", () => {
    expect(accountAnalyticsValue([receipt(false, CONSENT_MAX_AGE_DAYS + 1), receipt(true, 3)], NOW)).toBe(true);
    expect(accountAnalyticsValue([receipt(true, 1, CONSENT_REVISION - 1)], NOW)).toBeNull();
    expect(accountAnalyticsValue([receipt(false, CONSENT_MAX_AGE_DAYS + 1)], NOW)).toBeNull();
  });
});
