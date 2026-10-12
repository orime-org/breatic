import { describe, expect, it } from "vitest";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_REVISION,
  NO_CONSENT,
  parseConsentCookie,
  requiresOptIn,
} from "../analytics/consent.js";

function cookieValue(fields: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(fields));
}

describe("parseConsentCookie", () => {
  it("names the cookie both repos agree on", () => {
    expect(CONSENT_COOKIE_NAME).toBe("breatic_consent");
  });

  it("treats a missing cookie as no consent", () => {
    expect(parseConsentCookie(undefined)).toEqual(NO_CONSENT);
    expect(parseConsentCookie("")).toEqual(NO_CONSENT);
  });

  it("treats a corrupt cookie as no consent", () => {
    expect(parseConsentCookie("not-json")).toEqual(NO_CONSENT);
    expect(parseConsentCookie(encodeURIComponent("[1,2]"))).toEqual(NO_CONSENT);
    expect(parseConsentCookie(cookieValue({ categories: "analytics", revision: CONSENT_REVISION }))).toEqual(NO_CONSENT);
  });

  it("reads each category from the accepted list", () => {
    expect(
      parseConsentCookie(cookieValue({ categories: ["necessary", "analytics"], revision: CONSENT_REVISION })),
    ).toEqual({ analytics: true, ads: false });
    expect(
      parseConsentCookie(cookieValue({ categories: ["necessary", "analytics", "ads"], revision: CONSENT_REVISION })),
    ).toEqual({ analytics: true, ads: true });
    expect(
      parseConsentCookie(cookieValue({ categories: ["necessary"], revision: CONSENT_REVISION })),
    ).toEqual({ analytics: false, ads: false });
  });

  it("accepts the cookie written without URI encoding", () => {
    expect(
      parseConsentCookie(JSON.stringify({ categories: ["ads"], revision: CONSENT_REVISION })),
    ).toEqual({ analytics: false, ads: true });
  });

  it("drops a choice made under an older policy revision", () => {
    expect(
      parseConsentCookie(cookieValue({ categories: ["analytics", "ads"], revision: CONSENT_REVISION - 1 })),
    ).toEqual(NO_CONSENT);
  });

  it("ignores category names it does not know", () => {
    expect(
      parseConsentCookie(cookieValue({ categories: ["marketing", "analytics"], revision: CONSENT_REVISION })),
    ).toEqual({ analytics: true, ads: false });
  });
});

describe("requiresOptIn", () => {
  it("asks first in the EEA, the UK, Switzerland and mainland China", () => {
    for (const country of ["DE", "FR", "IE", "IS", "LI", "NO", "GB", "CH", "CN"]) {
      expect(requiresOptIn(country)).toBe(true);
    }
  });

  it("defaults on elsewhere", () => {
    for (const country of ["US", "JP", "KR", "TW", "HK", "SG", "BR"]) {
      expect(requiresOptIn(country)).toBe(false);
    }
  });

  // Cloudflare reports `XX` when it cannot place the visitor and `T1` for Tor.
  it("asks first when the country is unknown", () => {
    expect(requiresOptIn(null)).toBe(true);
    expect(requiresOptIn("")).toBe(true);
    expect(requiresOptIn("XX")).toBe(true);
    expect(requiresOptIn("T1")).toBe(true);
  });

  it("matches country codes regardless of case", () => {
    expect(requiresOptIn("de")).toBe(true);
    expect(requiresOptIn("us")).toBe(false);
  });
});
