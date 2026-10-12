// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { parseAttribution } from "@shared/analytics/attribution.js";

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
