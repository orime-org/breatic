// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import {
  type AccountAdsView,
  ADS_SHARING_FIELDS,
  AdsSharingSchema,
  BrowserAdsSnapshotSchema,
  adsAllowed,
  adsOptedOut,
  adsStatus,
} from "../analytics/ads-sharing.js";
import { CONSENT_REVISION } from "../analytics/consent.js";

const sharing = (optedOut: boolean): AccountAdsView => ({ optedOut, source: optedOut ? "settings" : null });
const consenting = { consent: true, gpc: false };

describe("adsAllowed with a browser (design §4.4.6)", () => {
  it("lets ads run when the browser consents, sends no GPC and the account has not opted out", () => {
    expect(adsAllowed({ browser: consenting, account: sharing(false) })).toBe(true);
  });

  it("lets ads run for a signed-out browser on its own choice", () => {
    expect(adsAllowed({ browser: consenting, account: "signedOut" })).toBe(true);
  });

  it.each([
    ["the browser does not consent", { consent: false, gpc: false }, sharing(false)],
    ["the browser sends GPC", { consent: true, gpc: true }, sharing(false)],
    ["the account has opted out", consenting, sharing(true)],
  ] as const)("stops ads when %s", (_label, browser, account) => {
    expect(adsAllowed({ browser, account })).toBe(false);
  });

  it("stops ads while the signed-in account's switch is not known yet", () => {
    expect(adsAllowed({ browser: consenting, account: "unknown" })).toBe(false);
  });

  it("stops ads for a deleted account", () => {
    expect(adsAllowed({ browser: consenting, account: "deleted" })).toBe(false);
  });
});

describe("adsAllowed without a browser (design §4.4.5)", () => {
  it("follows the ads choice last seen while signed in", () => {
    const seen = { value: true, revision: CONSENT_REVISION };
    expect(adsAllowed({ browser: null, account: sharing(false), seen })).toBe(true);
  });

  it("sends nothing when no choice was ever seen", () => {
    expect(adsAllowed({ browser: null, account: sharing(false), seen: null })).toBe(false);
  });

  it("sends nothing when the last seen choice was a refusal", () => {
    const seen = { value: false, revision: CONSENT_REVISION };
    expect(adsAllowed({ browser: null, account: sharing(false), seen })).toBe(false);
  });

  it("sends nothing when the last seen choice is under a revision no longer in force", () => {
    const seen = { value: true, revision: CONSENT_REVISION - 1 };
    expect(adsAllowed({ browser: null, account: sharing(false), seen })).toBe(false);
  });

  it("sends nothing once the account has opted out, whatever was seen", () => {
    const seen = { value: true, revision: CONSENT_REVISION };
    expect(adsAllowed({ browser: null, account: sharing(true), seen })).toBe(false);
  });

  it("sends nothing for a deleted account", () => {
    const seen = { value: true, revision: CONSENT_REVISION };
    expect(adsAllowed({ browser: null, account: "deleted", seen })).toBe(false);
  });
});

describe("adsOptedOut — the click table's opt-out state (design §4.4.4)", () => {
  it.each([
    ["the browser sends GPC", { browserAds: true, gpc: true, account: sharing(false) }, true],
    ["the browser's ads choice is a refusal", { browserAds: false, gpc: false, account: "signedOut" }, true],
    ["the signed-in account has opted out", { browserAds: null, gpc: false, account: sharing(true) }, true],
    ["nothing is opted out", { browserAds: true, gpc: false, account: sharing(false) }, false],
    ["the browser has no ads choice yet", { browserAds: null, gpc: false, account: "signedOut" }, false],
    ["the account is unknown and the browser consents", { browserAds: true, gpc: false, account: "unknown" }, false],
    ["the account is unknown and the browser refused", { browserAds: false, gpc: false, account: "unknown" }, true],
  ] as const)("is %s → %s", (_label, input, expected) => {
    expect(adsOptedOut(input)).toBe(expected);
  });

  // A revision change sends analytics back to unchosen and keeps the ads refusal (§4.4.4).
  it.each([
    ["signed out", "signedOut"],
    ["signed in with the account not opted out", sharing(false)],
  ] as const)("keeps an ads refusal carried across a revision change opted out when %s", (_label, account) => {
    expect(adsOptedOut({ browserAds: false, gpc: false, account })).toBe(true);
  });
});

describe("adsStatus — the settings window's status line (design §4.4.6)", () => {
  it("says GPC first, whatever the account says", () => {
    expect(adsStatus({ gpc: true, account: sharing(true) })).toBe("gpc");
    expect(adsStatus({ gpc: true, account: "signedOut" })).toBe("gpc");
  });

  it("says the account has opted out when it has", () => {
    expect(adsStatus({ gpc: false, account: sharing(true) })).toBe("account");
  });

  it("says the choice is this browser's only when nobody is signed in", () => {
    expect(adsStatus({ gpc: false, account: "signedOut" })).toBe("browser");
  });

  it("says nothing when the signed-in account has not opted out or is not known yet", () => {
    expect(adsStatus({ gpc: false, account: sharing(false) })).toBeNull();
    expect(adsStatus({ gpc: false, account: "unknown" })).toBeNull();
  });
});

describe("contract shapes", () => {
  it("reads the account switch answer and refuses anything else", () => {
    expect(AdsSharingSchema.parse({ optedOut: true, source: "gpc" })).toEqual({ optedOut: true, source: "gpc" });
    expect(AdsSharingSchema.parse({ optedOut: false, source: null })).toEqual({ optedOut: false, source: null });
    expect(AdsSharingSchema.safeParse({ optedOut: "yes", source: null }).success).toBe(false);
    expect(AdsSharingSchema.safeParse({ optedOut: true, source: "banner" }).success).toBe(false);
    expect(AdsSharingSchema.safeParse({ optedOut: true, source: "gpc", extra: 1 }).success).toBe(false);
  });

  it("names the answer's fields for the website's contract test", () => {
    expect([...ADS_SHARING_FIELDS]).toEqual(["optedOut", "source"]);
  });

  it("stores a browser snapshot as this browser's ads consent and whether it sent GPC", () => {
    expect(BrowserAdsSnapshotSchema.parse({ consent: true, gpc: false })).toEqual({ consent: true, gpc: false });
    expect(BrowserAdsSnapshotSchema.safeParse({ consent: true }).success).toBe(false);
  });
});
