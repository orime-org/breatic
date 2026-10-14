// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1442 §4.4.3a — a self-hosted copy writes the consent cookie back from
 * the server, as the hosted frontend Worker does, so Safari's seven-day cap on
 * script-written cookies does not end a choice early.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { consentRefreshRoute } = await import("@server/routes/consent-refresh.js");

const NOW = Date.parse("2026-10-14T00:00:00Z");
const DAY = 86_400_000;

/**
 * A consent cookie value as the banner library writes it.
 * @param over - Fields to replace.
 * @returns The encoded value.
 */
function consent(over: Record<string, unknown> = {}): string {
  return encodeURIComponent(
    JSON.stringify({ categories: ["necessary"], revision: 1, consentId: "abc", expirationTime: NOW + 300 * DAY, ...over }),
  );
}

/**
 * Ask the route as the self-hosted nginx forwards the page's request.
 * @param cookie - The Cookie header.
 * @param options - The page's host, the domain it names, its scheme, and the method.
 * @param options.host - The page's host.
 * @param options.domain - The domain the page's banner library wrote under; null for none.
 * @param options.proto - The page's scheme.
 * @param options.method - The method.
 * @returns The response.
 */
async function refresh(
  cookie?: string,
  options: { host?: string; domain?: string | null; proto?: string; method?: string } = {},
): Promise<Response> {
  const { host = "breatic.example.com", proto = "https", method = "GET" } = options;
  const domain = options.domain === undefined ? host : options.domain;
  const headers: Record<string, string> = { host, "x-forwarded-proto": proto };
  if (cookie !== undefined) headers.cookie = cookie;
  const query = domain === null ? "" : `?domain=${encodeURIComponent(domain)}`;
  return consentRefreshRoute.request(`http://${host}/${query}`, { method, headers });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("GET /_consent/refresh on a self-hosted copy", () => {
  it("writes the value back unchanged, under the page's host as the banner library does", async () => {
    const value = consent();
    const r = await refresh(`other=1; breatic_consent=${value}`);
    expect(r.status).toBe(204);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const set = r.headers.get("set-cookie") ?? "";
    expect(set.startsWith(`breatic_consent=${value};`)).toBe(true);
    for (const part of [
      "Domain=breatic.example.com",
      "Path=/",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${300 * 86400}`,
      `Expires=${new Date(NOW + 300 * DAY).toUTCString()}`,
    ]) {
      expect(set).toContain(part);
    }
    expect(set.toLowerCase()).not.toContain("httponly");
  });

  it("writes under the parent domain the page names", async () => {
    const set = (await refresh(`breatic_consent=${consent()}`, { host: "app.example.com", domain: "example.com" })).headers.get("set-cookie") ?? "";
    expect(set).toContain("Domain=example.com");
    const dotted = (await refresh(`breatic_consent=${consent()}`, { host: "app.example.com", domain: ".example.com" })).headers.get("set-cookie") ?? "";
    expect(dotted).toContain("Domain=example.com;");
  });

  it("reads the named domain as the browser stores it: lower case, international names in punycode", async () => {
    const upper = (await refresh(`breatic_consent=${consent()}`, { host: "app.example.com", domain: "Example.COM" })).headers.get("set-cookie") ?? "";
    expect(upper).toContain("Domain=example.com;");
    const idn = (await refresh(`breatic_consent=${consent()}`, { host: "app.xn--r8jz45g.jp", domain: "例え.jp" })).headers.get("set-cookie") ?? "";
    expect(idn).toContain("Domain=xn--r8jz45g.jp;");
    const unparsable = await refresh(`breatic_consent=${consent()}`, { host: "app.example.com", domain: "exa mple.com" });
    expect(unparsable.headers.get("set-cookie")).toBeNull();
  });

  it("writes nothing for a domain the page's host does not belong to, or none at all", async () => {
    for (const [host, domain] of [
      ["app.example.com", "other.com"],
      ["badexample.com", "example.com"],
      ["app.example.com", "sub.app.example.com"],
      ["app.example.com", ""],
      ["app.example.com", null],
    ] as const) {
      const r = await refresh(`breatic_consent=${consent()}`, { host, domain });
      expect(r.status).toBe(204);
      expect(r.headers.get("set-cookie"), `${host} ${String(domain)}`).toBeNull();
    }
  });

  it("follows the library on a plain-http host without a dot: no Secure, no Domain", async () => {
    const set = (await refresh(`breatic_consent=${consent()}`, { host: "localhost", proto: "http" })).headers.get("set-cookie") ?? "";
    expect(set).not.toContain("Secure");
    expect(set).not.toContain("Domain=");
  });

  it("writes nothing without one readable consent cookie", async () => {
    for (const cookie of [
      undefined,
      "other=1",
      `breatic_consent=${consent()}; breatic_consent=${consent({ consentId: "def" })}`,
      `breatic_consent=${consent({ pad: "x".repeat(5000) })}`,
      `breatic_consent=${consent({ consentId: undefined })}`,
      `breatic_consent=${consent({ revision: undefined })}`,
      `breatic_consent=${consent({ expirationTime: NOW - DAY })}`,
      "breatic_consent=%E0%A4%A",
      "breatic_consent=not-json",
    ]) {
      const r = await refresh(cookie);
      expect(r.status).toBe(204);
      expect(r.headers.get("set-cookie"), String(cookie)).toBeNull();
    }
  });

  it("caps the lifetime at the cookie's 395 days", async () => {
    const set = (await refresh(`breatic_consent=${consent({ expirationTime: NOW + 500 * DAY })}`)).headers.get("set-cookie") ?? "";
    expect(set).toContain(`Max-Age=${395 * 86400}`);
  });
});
