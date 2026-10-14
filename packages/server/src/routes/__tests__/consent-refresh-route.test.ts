// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1442 §4.4.3a — a self-hosted copy writes the consent cookie back from
 * the server, as the hosted frontend Worker does, so Safari's seven-day cap on
 * script-written cookies does not end a choice early.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const config = vi.hoisted(() => ({ COOKIE_DOMAIN: "" }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, env: { get COOKIE_DOMAIN() { return config.COOKIE_DOMAIN; } } };
});

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
 * @param options - The page's host and scheme, and the method.
 * @param options.host - The page's host.
 * @param options.proto - The page's scheme.
 * @param options.method - The method.
 * @returns The response.
 */
async function refresh(cookie?: string, { host = "breatic.example.com", proto = "https", method = "GET" } = {}): Promise<Response> {
  const headers: Record<string, string> = { host, "x-forwarded-proto": proto };
  if (cookie !== undefined) headers.cookie = cookie;
  return consentRefreshRoute.request(`http://${host}/`, { method, headers });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  config.COOKIE_DOMAIN = "";
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

  it("writes under COOKIE_DOMAIN when one is set", async () => {
    config.COOKIE_DOMAIN = "example.com";
    const set = (await refresh(`breatic_consent=${consent()}`)).headers.get("set-cookie") ?? "";
    expect(set).toContain("Domain=example.com");
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
