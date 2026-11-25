// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Which server the desktop client opens (inner#2041, design 6). Every build is
 * dedicated to one server written in at build time: an empty or non-HTTPS
 * address fails the build, and the client opens that server. In development
 * `BREATIC_SERVER_URL` overrides it under the same rules.
 */

import { describe, it, expect } from "vitest";

import { builtInServerUrl, normalizeServerUrl, resolveServerUrl } from "@desktop/main/server-config.js";

describe("normalizeServerUrl", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com"],
    ["https://app.example.com/studio?x=1", "https://app.example.com"],
    ["  https://192.168.1.50  ", "https://192.168.1.50"],
    ["https://team.example.com:8443/", "https://team.example.com:8443"],
    ["http://localhost:8100", "http://localhost:8100"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://[::1]:8000/", "http://[::1]:8000"],
  ])("accepts %s as %s", (input, origin) => {
    expect(normalizeServerUrl(input)).toBe(origin);
  });

  it.each(["http://192.168.1.50", "http://app.example.com", "ftp://app.example.com", "app.example.com", "", "not a url", "file:///etc/passwd"])(
    "refuses %s",
    (input) => {
      expect(normalizeServerUrl(input)).toBeNull();
    },
  );
});
describe("builtInServerUrl", () => {
  it("keeps the origin of an address the address rules accept", () => {
    expect(builtInServerUrl("https://studio.example.test/")).toBe("https://studio.example.test");
    expect(builtInServerUrl("http://localhost:8100")).toBe("http://localhost:8100");
  });

  it.each(["", "  ", "studio.example.test", "http://192.168.1.10:8000", "ftp://example.test"])("fails the build for %j", (raw) => {
    expect(() => builtInServerUrl(raw)).toThrow(/serverUrl/);
  });
});

describe("resolveServerUrl", () => {
  it("opens the server the build carries", () => {
    expect(resolveServerUrl({ envUrl: undefined, builtInUrl: "https://app.example.com" })).toBe("https://app.example.com");
  });

  it("lets BREATIC_SERVER_URL override it in development", () => {
    expect(resolveServerUrl({ envUrl: "http://localhost:8100", builtInUrl: "https://app.example.com" })).toBe("http://localhost:8100");
  });

  it("throws on an override the client refuses", () => {
    expect(() => resolveServerUrl({ envUrl: "http://10.0.0.2", builtInUrl: "https://app.example.com" })).toThrow(/BREATIC_SERVER_URL/);
  });
});
