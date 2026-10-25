// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The public app's request body limit (inner#1006 §3.2): T07, T11, T12, T13.
 *
 * The middleware is mounted on a minimal Hono app in front of a spy route, so
 * these cases see exactly what it reads, what it logs and what it answers. The
 * real-socket cases (T01–T10) are in
 * `src/__tests__/integration/request-body-limit.integration.test.ts`.
 *
 * The module under test is imported inside each case, so a case that only
 * reads the locale files does not fail on the import.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { accounts, logged, cookie } = vi.hoisted(() => ({
  accounts: { getUserByToken: vi.fn() },
  logged: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  cookie: { token: undefined as string | undefined },
}));

vi.mock("@server/middleware/session-cookie.js", () => ({
  readSessionCookie: () => cookie.token,
}));

vi.mock("@server/modules", () => ({ authService: accounts }));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

import { MONOREPO_ROOT, decideClientIdentity, loadLocales, runWithLocale } from "@breatic/core";
import { t } from "@breatic/shared";
import { getRequestBodyMaxBytes } from "@server/config/limits.js";
import { localeMiddleware } from "@server/middleware/i18n.js";
import { LOOPBACK_PEER, peer, withPeer } from "@server/__tests__/helpers/peer.js";

loadLocales();

const route = vi.fn();
const CHUNK = 65_536;

/**
 * The middleware under test, loaded from the path the design names.
 * @returns The `requestBodyLimit` middleware.
 */
async function loadLimit(): Promise<MiddlewareHandler> {
  const mod = await import("@server/middleware/request-body-limit.js");
  return mod.requestBodyLimit;
}

/**
 * A minimal app: locale, the body limit, then a spy route at `POST /x`.
 * @returns The app.
 */
async function appUnderTest(): Promise<Hono> {
  const limit = await loadLimit();
  const app = new Hono();
  app.use("*", localeMiddleware);
  app.use("*", limit);
  app.post("/x", async (c) => {
    route(await c.req.text());
    return c.text("ok");
  });
  return app;
}

/**
 * Every log call with a given message, at any level.
 * @param message - The pino message.
 * @returns The first argument of each matching call.
 */
function logsNamed(message: string): unknown[] {
  return [logged.error, logged.warn, logged.info, logged.debug].flatMap((fn) =>
    fn.mock.calls.filter((call) => call[1] === message).map((call) => call[0] as unknown),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cookie.token = undefined;
});

describe("T07: a chunked body is cut off once it passes the limit", () => {
  it("answers 413 without running the route and pulls at most two chunks past the limit", async () => {
    const L = getRequestBodyMaxBytes();
    const app = await appUnderTest();
    let pulled = 0;
    let served = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (served >= 1024) {
          controller.close();
          return;
        }
        served += 1;
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
    });
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    const res = await runWithLocale("en", () => app.fetch(request, LOOPBACK_PEER));

    expect(res.status).toBe(413);
    expect(route).not.toHaveBeenCalled();
    // The 17th chunk takes the running total past L; one more may be prefetched.
    expect(L + 2 * CHUNK).toBe(1_179_648);
    expect(pulled).toBeLessThanOrEqual(L + 2 * CHUNK);
  });
});

describe("T11: the client address logged for a refused body", () => {
  /**
   * Send `L + 1` bytes from a non-loopback peer.
   * @param realIp - The `X-Real-IP` header, when sent.
   * @returns The response.
   */
  async function sendFrom(realIp: string | undefined): Promise<Response> {
    const L = getRequestBodyMaxBytes();
    const app = withPeer(await appUnderTest(), peer("198.51.100.9"));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(L + 1),
    };
    if (realIp !== undefined) headers["X-Real-IP"] = realIp;
    return app.request("/x", { method: "POST", headers, body: " ".repeat(L + 1) });
  }

  it.each([
    ["(a) a proxied request", "203.0.113.7", { kind: "identify", identity: "203.0.113.7" }],
    ["(b) a request that skipped the proxy", undefined, { kind: "refuse", reason: "missing-real-ip" }],
    ["(c) an IPv6 client, counted by its /64", "2001:db8:1:2:3:4:5:6", { kind: "identify", identity: "2001:db8:1:2::/64" }],
  ] as const)("%s is refused with 413 and logged with its decision", async (_name, realIp, client) => {
    const L = getRequestBodyMaxBytes();
    // The middleware uses the rate limiter's own rule, so the expectation is
    // that rule's answer for the same input.
    expect(decideClientIdentity({ peerAddress: "198.51.100.9", realIpHeader: realIp })).toEqual(client);

    const res = await sendFrom(realIp);

    expect(res.status).toBe(413);
    expect(route).not.toHaveBeenCalled();
    expect(logsNamed("request_body_too_large")).toEqual([
      { path: "/x", method: "POST", declaredBytes: L + 1, client, userId: null },
    ]);
    expect(logged.warn).toHaveBeenCalledWith(
      { path: "/x", method: "POST", declaredBytes: L + 1, client, userId: null },
      "request_body_too_large",
    );
  });
});

describe("T12: the session lookup behind the logged user id", () => {
  /**
   * Send `L + 1` bytes with a session cookie.
   * @param token - The cookie's token.
   * @returns The response.
   */
  async function sendWithToken(token: string): Promise<Response> {
    const L = getRequestBodyMaxBytes();
    cookie.token = token;
    const app = withPeer(await appUnderTest());
    return app.request("/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(L + 1) },
      body: " ".repeat(L + 1),
    });
  }

  it("(a) a token with no session logs userId null and nothing else", async () => {
    accounts.getUserByToken.mockResolvedValue(null);

    const res = await sendWithToken("no-such-session-token");

    expect(res.status).toBe(413);
    expect(accounts.getUserByToken.mock.calls).toEqual([["no-such-session-token"]]);
    expect(logsNamed("request_body_too_large")).toEqual([
      expect.objectContaining({ userId: null }),
    ]);
    expect(logsNamed("request_body_session_lookup_failed")).toEqual([]);
  });

  it("(b) a failed lookup still answers 413, logs the failure once and never the token", async () => {
    const token = "raw-session-token-7f3a9c";
    // What `getSession` throws on a Redis read failure: the message is
    // already scrubbed of the token (core/src/infra/session-store.ts:74).
    const failure = Object.assign(new Error("Command timed out"), { code: 503 });
    accounts.getUserByToken.mockRejectedValue(failure);

    const res = await sendWithToken(token);
    const body: unknown = await res.json();

    expect(res.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: 413,
        message: runWithLocale("en", () => t("server.error.payload_too_large", { limit: "1 MiB" })),
      },
    });
    expect(logsNamed("request_body_too_large")).toEqual([
      expect.objectContaining({ userId: null }),
    ]);
    expect(logsNamed("request_body_session_lookup_failed")).toEqual([
      expect.objectContaining({ err: failure }),
    ]);
    const everything = JSON.stringify(
      [logged.error, logged.warn, logged.info, logged.debug].map((fn) => fn.mock.calls),
      (_key, value: unknown) => (value instanceof Error ? { message: value.message, stack: value.stack } : value),
    );
    expect(everything).not.toContain(token);
  });

  it("(c) a revoked session logs userId null and no lookup failure", async () => {
    // A revoked session reads back as no session; the real-Redis version of
    // this case is T12(c) in the integration suite.
    accounts.getUserByToken.mockResolvedValue(null);

    const res = await sendWithToken("revoked-session-token");

    expect(res.status).toBe(413);
    expect(logsNamed("request_body_too_large")).toEqual([
      expect.objectContaining({ userId: null }),
    ]);
    expect(logsNamed("request_body_session_lookup_failed")).toEqual([]);
  });
});

describe("T13: the payload_too_large copy", () => {
  const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;
  const ENGLISH = "This request is larger than {limit}. Shorten the prompt or the text it refers to.";

  /**
   * The raw `server.error.payload_too_large` value of one locale file.
   * @param locale - The locale.
   * @returns The value, or undefined when the key is missing.
   */
  function rawCopy(locale: string): unknown {
    const file = JSON.parse(readFileSync(resolve(MONOREPO_ROOT, "locales", `${locale}.json`), "utf-8")) as {
      server?: { error?: Record<string, unknown> };
    };
    return file.server?.error?.payload_too_large;
  }

  it.each(LOCALES)("%s has the key with a {limit} placeholder and no number written in", (locale) => {
    const value = rawCopy(locale);
    expect(typeof value).toBe("string");
    expect(value as string).toContain("{limit}");
    expect(/\d/.test((value as string).replaceAll("{limit}", ""))).toBe(false);
  });

  it("the English copy is the design's sentence", () => {
    expect(rawCopy("en")).toBe(ENGLISH);
  });

  it("a zh-CN request is refused in zh-CN with the configured limit filled in", async () => {
    const L = getRequestBodyMaxBytes();
    const app = withPeer(await appUnderTest());

    const res = await app.request("/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(L + 1), "Accept-Language": "zh-CN" },
      body: " ".repeat(L + 1),
    });

    expect(res.status).toBe(413);
    const zh = runWithLocale("zh-CN", () => t("server.error.payload_too_large", { limit: "1 MiB" }));
    expect(zh).not.toBe("server.error.payload_too_large");
    expect(await res.json()).toEqual({ error: { code: 413, message: zh } });
  });
});
