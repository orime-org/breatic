// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import {
  type AccountAdsReceipt,
  type AdsEvent,
  type BrowserAds,
  accountAdsEvents,
  adsConsentOverridesOptOut,
  adsDecision,
  browserSuppressesOwnGpc,
  normalizeBrowserAds,
} from "../analytics/ads-decision.js";
import { CONSENT_MAX_AGE_DAYS, CONSENT_REVISION } from "../analytics/consent.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function cookie(over: Partial<BrowserAds> = {}): BrowserAds {
  return {
    decisionId: "11111111-1111-4111-8111-111111111111",
    value: true,
    source: "banner",
    noticeShown: false,
    gpcAtDecision: false,
    decidedAt: iso(NOW - DAY),
    revision: CONSENT_REVISION,
    ...over,
  };
}

function receipt(over: Partial<AccountAdsReceipt> = {}): AccountAdsReceipt {
  return {
    decisionId: "22222222-2222-4222-8222-222222222222",
    value: true,
    source: "banner",
    noticeShown: false,
    decidedAt: iso(NOW - DAY),
    revision: CONSENT_REVISION,
    ...over,
  };
}

const consent = (at: number): AdsEvent => ({ kind: "consent", at });
const refusal = (at: number): AdsEvent => ({ kind: "refusal", at });
const gpc = (at: number): AdsEvent => ({ kind: "gpc", at });
const override = (notice: "account" | "gpc", at: number): AdsEvent => ({ kind: "override", notice, at });

describe("adsConsentOverridesOptOut", () => {
  it("holds only for a settings consent saved while an opt-out notice showed", () => {
    expect(adsConsentOverridesOptOut(cookie({ source: "settings", noticeShown: "account" }))).toBe(true);
    expect(adsConsentOverridesOptOut(cookie({ source: "settings", noticeShown: "gpc" }))).toBe(true);
    expect(adsConsentOverridesOptOut(cookie({ source: "settings", noticeShown: false }))).toBe(false);
    expect(adsConsentOverridesOptOut(cookie({ source: "banner", noticeShown: "account" }))).toBe(false);
    expect(adsConsentOverridesOptOut(cookie({ source: "settings", noticeShown: "account", value: false }))).toBe(false);
  });
});

describe("browserSuppressesOwnGpc", () => {
  const savedWithGpc = cookie({ source: "settings", noticeShown: "gpc", gpcAtDecision: true });

  it("exempts this browser's GPC only for an override saved while it sent GPC", () => {
    expect(browserSuppressesOwnGpc(savedWithGpc, "none")).toBe(true);
    expect(browserSuppressesOwnGpc({ ...savedWithGpc, gpcAtDecision: false }, "none")).toBe(false);
  });

  it("gives the same answer before and after the override is recorded", () => {
    expect(browserSuppressesOwnGpc(savedWithGpc, "self")).toBe(browserSuppressesOwnGpc(savedWithGpc, "none"));
  });

  it("does not exempt GPC for an override another account left in the cookie", () => {
    expect(browserSuppressesOwnGpc(savedWithGpc, "other")).toBe(false);
  });

  it("does not exempt GPC without a cookie", () => {
    expect(browserSuppressesOwnGpc(null, "none")).toBe(false);
  });
});

describe("normalizeBrowserAds", () => {
  it("drops the cookie copy when the account already holds that decision", () => {
    expect(normalizeBrowserAds(cookie(), "self", NOW)).toEqual({ event: null, unset: false });
  });

  it("keeps a refusal another account recorded as a refusal, timed now", () => {
    expect(normalizeBrowserAds(cookie({ value: false }), "other", NOW)).toEqual({ event: refusal(NOW), unset: false });
  });

  it("keeps a consent another account recorded as a consent, at the earlier of cookie time and now", () => {
    expect(normalizeBrowserAds(cookie(), "other", NOW)).toEqual({ event: consent(NOW - DAY), unset: false });
    const ahead = cookie({ decidedAt: iso(NOW + DAY) });
    expect(normalizeBrowserAds(ahead, "other", NOW)).toEqual({ event: consent(NOW), unset: false });
  });

  it("turns an override another account recorded into a plain consent", () => {
    const o = cookie({ source: "settings", noticeShown: "account" });
    expect(normalizeBrowserAds(o, "other", NOW)).toEqual({ event: consent(NOW - DAY), unset: false });
  });

  it("turns an unrecorded override into a plain consent and times a refusal now", () => {
    const o = cookie({ source: "settings", noticeShown: "account", decidedAt: iso(NOW + DAY) });
    expect(normalizeBrowserAds(o, "none", NOW)).toEqual({ event: consent(NOW), unset: false });
    expect(normalizeBrowserAds(cookie({ value: false }), "none", NOW)).toEqual({ event: refusal(NOW), unset: false });
  });

  it("reports the browser as unset with no cookie or an expired consent", () => {
    expect(normalizeBrowserAds(null, "none", NOW)).toEqual({ event: null, unset: true });
    const old = cookie({ decidedAt: iso(NOW - (CONSENT_MAX_AGE_DAYS + 1) * DAY) });
    expect(normalizeBrowserAds(old, "none", NOW).unset).toBe(true);
    expect(normalizeBrowserAds(old, "self", NOW).unset).toBe(true);
  });

  it("keeps an old refusal, which never expires", () => {
    const old = cookie({ value: false, decidedAt: iso(NOW - 1000 * DAY) });
    expect(normalizeBrowserAds(old, "none", NOW).unset).toBe(false);
  });
});

describe("accountAdsEvents", () => {
  it("maps receipts and the GPC signal to events", () => {
    const events = accountAdsEvents(
      [
        receipt({ decidedAt: iso(NOW - 3 * DAY) }),
        receipt({ value: false, source: "settings", decidedAt: iso(NOW - 2 * DAY) }),
        receipt({ source: "settings", noticeShown: "account", decidedAt: iso(NOW - DAY) }),
      ],
      iso(NOW - 10 * DAY),
      NOW,
    );
    expect(events).toEqual([
      consent(NOW - 3 * DAY),
      refusal(NOW - 2 * DAY),
      override("account", NOW - DAY),
      gpc(NOW - 10 * DAY),
    ]);
  });

  it("drops consents past 395 days or from an old revision, and keeps old refusals", () => {
    const old = NOW - (CONSENT_MAX_AGE_DAYS + 1) * DAY;
    const events = accountAdsEvents(
      [
        receipt({ decidedAt: iso(old) }),
        receipt({ revision: CONSENT_REVISION - 1 }),
        receipt({ value: false, decidedAt: iso(NOW - 1000 * DAY), revision: CONSENT_REVISION - 1 }),
      ],
      null,
      NOW,
    );
    expect(events).toEqual([refusal(NOW - 1000 * DAY)]);
  });
});

describe("adsDecision", () => {
  type State = "none" | "consent" | "gpc" | "account" | "both";
  const T = NOW - 10 * DAY;
  const setup: Record<State, AdsEvent[]> = {
    none: [],
    consent: [consent(T)],
    gpc: [gpc(T)],
    account: [refusal(T)],
    both: [refusal(T), gpc(T + 1)],
  };
  const later = T + DAY;
  const steps: Record<string, AdsEvent> = {
    consent: consent(later),
    "override account": override("account", later),
    "override gpc": override("gpc", later),
    refusal: refusal(later),
    gpc: gpc(later),
  };
  const expected: Record<State, Record<string, State>> = {
    none: { consent: "consent", "override account": "consent", "override gpc": "consent", refusal: "account", gpc: "gpc" },
    consent: { consent: "consent", "override account": "consent", "override gpc": "consent", refusal: "account", gpc: "gpc" },
    gpc: { consent: "gpc", "override account": "consent", "override gpc": "consent", refusal: "both", gpc: "gpc" },
    account: { consent: "account", "override account": "consent", "override gpc": "account", refusal: "account", gpc: "both" },
    both: { consent: "both", "override account": "consent", "override gpc": "account", refusal: "both", gpc: "both" },
  };
  const view = (state: State): { allowed: boolean; notice: "account" | "gpc" | null } => {
    if (state === "consent") return { allowed: true, notice: null };
    if (state === "none") return { allowed: false, notice: null };
    return { allowed: false, notice: state === "gpc" ? "gpc" : "account" };
  };

  for (const [from, row] of Object.entries(expected) as [State, Record<string, State>][]) {
    for (const [step, to] of Object.entries(row)) {
      it(`${from} then ${step} gives ${to}`, () => {
        expect(adsDecision([...setup[from], steps[step]!])).toEqual(view(to));
      });
    }
  }

  it("orders by time, whatever order the events arrive in", () => {
    const events = [override("account", T + 3), refusal(T + 1), consent(T), gpc(T + 2)];
    const forward = adsDecision(events);
    expect(adsDecision([...events].reverse())).toEqual(forward);
    expect(forward).toEqual({ allowed: true, notice: null });
  });

  it("lets the stricter event win a tie", () => {
    expect(adsDecision([consent(T), refusal(T)])).toEqual({ allowed: false, notice: "account" });
    expect(adsDecision([refusal(T), consent(T)])).toEqual({ allowed: false, notice: "account" });
  });

  it("gives every combination of four events the same answer in any arrival order", () => {
    const kinds: AdsEvent[] = [consent(0), refusal(0), gpc(0), override("account", 0), override("gpc", 0)];
    for (const a of kinds)
      for (const b of kinds)
        for (const c of kinds)
          for (const d of kinds) {
            const seq = [a, b, c, d].map((e, i) => ({ ...e, at: T + i }));
            expect(adsDecision([...seq].reverse())).toEqual(adsDecision(seq));
          }
  });
});
