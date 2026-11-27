// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Origin allow-list matching for the services that carry no login state
 * (the ingest Worker; inner#2157 design 7.5). Upload parts are authorised by
 * their ticket, so ingest admits every influencer site with one wildcard
 * entry, `https://*.partner.<domain>`, instead of a redeploy per influencer.
 *
 * A wildcard entry matches exactly one label below its domain, on the same
 * scheme; every other entry is an exact origin.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { originMatches } from "@shared/http/origin-matches.js";

const ENTRIES = ["https://breatic.test", "https://*.partner.breatic.test"];

describe("originMatches", () => {
  it("matches an exact entry", () => {
    expect(originMatches("https://breatic.test", ENTRIES)).toBe(true);
  });

  it("matches one label below the wildcard's domain", () => {
    expect(originMatches("https://alice.partner.breatic.test", ENTRIES)).toBe(true);
  });

  it.each([
    ["the wildcard's domain itself", "https://partner.breatic.test"],
    ["two labels below the domain", "https://a.alice.partner.breatic.test"],
    ["a sibling of the partner domain", "https://alice.breatic.test"],
    ["another scheme", "http://alice.partner.breatic.test"],
    ["an explicit port", "https://alice.partner.breatic.test:8443"],
    ["a lookalike suffix", "https://alice.partner.breatic.test.attacker.test"],
    ["a domain that only ends with the same text", "https://alicepartner.breatic.test"],
    ["an unrelated site", "https://attacker.test"],
    ["the opaque origin", "null"],
    ["an empty origin", ""],
  ])("does not match %s (%s)", (_label, origin) => {
    expect(originMatches(origin, ENTRIES)).toBe(false);
  });

  it("does not let an exact entry match its own subdomains", () => {
    expect(originMatches("https://alice.breatic.test", ["https://breatic.test"])).toBe(false);
  });

  it("matches nothing against an empty list", () => {
    expect(originMatches("https://breatic.test", [])).toBe(false);
  });

  it("keeps an http wildcard to http only, for local development", () => {
    const local = ["http://*.partner.localhost:8000"];
    expect(originMatches("http://alice.partner.localhost:8000", local)).toBe(true);
    expect(originMatches("https://alice.partner.localhost:8000", local)).toBe(false);
    expect(originMatches("http://alice.partner.localhost:8001", local)).toBe(false);
  });

  it("matches every single lowercase label under the wildcard and nothing deeper", () => {
    const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,20}[a-z0-9])?$/);
    fc.assert(
      fc.property(label, label, (first, second) => {
        expect(originMatches(`https://${first}.partner.breatic.test`, ENTRIES)).toBe(true);
        expect(originMatches(`https://${first}.${second}.partner.breatic.test`, ENTRIES)).toBe(false);
        expect(originMatches(`http://${first}.partner.breatic.test`, ENTRIES)).toBe(false);
      }),
    );
  });
});
