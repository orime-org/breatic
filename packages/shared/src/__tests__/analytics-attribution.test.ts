// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { adClickFrom, parseAttribution } from "@shared/analytics/attribution.js";

const AT = "2026-10-12T01:00:00.000Z";

describe("parseAttribution", () => {
  it("keeps the campaign fields of both touches", () => {
    const touch = { utm_source: "google", utm_campaign: "launch", gclid: "abc", at: AT };
    expect(parseAttribution({ first: touch, last: touch })).toEqual({ first: touch, last: touch });
  });

  it("drops fields it does not know", () => {
    const touch = { utm_source: "x", email: "a@example.com", at: AT };
    expect(parseAttribution({ first: touch, last: touch })).toEqual({
      first: { utm_source: "x", at: AT },
      last: { utm_source: "x", at: AT },
    });
  });

  it("cuts addresses down so no query string is stored", () => {
    const touch = {
      referrer: "https://news.example.com/post/1?token=secret#x",
      landing_page: "https://example.com/pricing?gclid=abc",
      at: AT,
    };
    expect(parseAttribution({ first: touch, last: touch })?.first).toEqual({
      referrer: "https://news.example.com/post/1",
      landing_page: "/pricing",
      at: AT,
    });
  });

  it("cuts long values to 200 characters", () => {
    const touch = { utm_term: "x".repeat(500), at: AT };
    expect(parseAttribution({ first: touch, last: touch })?.first.utm_term).toHaveLength(200);
  });

  it("returns null for anything malformed instead of failing the sign-up", () => {
    for (const bad of [undefined, null, "x", {}, { first: {}, last: {} }, { first: { at: "soon" }, last: { at: AT } }]) {
      expect(parseAttribution(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("drops a referrer that is not an address", () => {
    const touch = { referrer: "not a url", at: AT };
    expect(parseAttribution({ first: touch, last: touch })?.first).toEqual({ at: AT });
  });
});

describe("adClickFrom", () => {
  const NOW = Date.parse("2026-10-12T00:00:00.000Z");
  const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

  it("takes the last touch's click when it is recent", () => {
    const attribution = { first: { gclid: "old", at: daysAgo(30) }, last: { gclid: "new", at: daysAgo(1) } };
    expect(adClickFrom(attribution, NOW)).toEqual({ gclid: "new", at: daysAgo(1) });
  });

  it("falls back to the first touch when the last one carried no click", () => {
    const attribution = { first: { gbraid: "g", at: daysAgo(10) }, last: { utm_source: "x", at: daysAgo(1) } };
    expect(adClickFrom(attribution, NOW)).toEqual({ gbraid: "g", at: daysAgo(10) });
  });

  it("sends one identifier, gclid first", () => {
    const attribution = { first: { at: daysAgo(1) }, last: { gclid: "c", gbraid: "g", wbraid: "w", at: daysAgo(1) } };
    expect(adClickFrom(attribution, NOW)).toEqual({ gclid: "c", at: daysAgo(1) });
  });

  it("ignores clicks older than 90 days", () => {
    const attribution = { first: { gclid: "a", at: daysAgo(91) }, last: { gclid: "b", at: daysAgo(91) } };
    expect(adClickFrom(attribution, NOW)).toBeNull();
  });

  it("returns null without attribution", () => {
    expect(adClickFrom(null, NOW)).toBeNull();
  });
});
