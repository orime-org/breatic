// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The limits on saving and re-checking an account's own upstream key (inner#1953), on a real Redis and database.
 *
 * Each sends a request to an upstream with the key it is given, so each is counted per user under its own
 * `config/rate-limits.yaml` entry, read through `rateLimitFor`; a request over the limit is answered 429 before any
 * check runs. The limits are lowered here to two a window.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** The two limits this file lowers. */
const LOWERED = vi.hoisted(() => new Set(["byok-key-write", "byok-key-check", "byok-model-write"]));

vi.mock("@server/config/rate-limits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimitsModule>();
  return {
    ...actual,
    getRateLimit: (action: string) => (LOWERED.has(action) ? { max: 2, windowSeconds: 60 } : actual.getRateLimit(action)),
  };
});

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import type * as RateLimitsModule from "@server/config/rate-limits.js";
import crypto, { randomBytes } from "node:crypto";
import postgres from "postgres";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { initProvider } from "@breatic/domain";
import type { Hono } from "hono";

const SECRET = randomBytes(32);
const checkKey = vi.fn(async () => ({ connected: true, balance: "unsupported" as const }));

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore({ ...process.env, BYOK_ENABLED: "true", PROVIDER_KEY_SECRET_ID: "t1", PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }) });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const real = initProvider();
  initProvider(new Proxy(real, { get: (target, prop, receiver) => (prop === "checkKey" ? checkKey : Reflect.get(target, prop, receiver)) }));
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A fresh verified account, signed in.
 * @returns A Cookie header for it.
 */
async function signedIn(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`byok-limit-${crypto.randomUUID().slice(0, 8)}@test.local`}, true) RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Save a key for an account.
 * @param cookie - Its Cookie header.
 * @returns The response.
 */
const save = async (cookie: string): Promise<Response> =>
  app.request("/api/v1/account/byok/keys/fal", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ key: `fal-${crypto.randomBytes(12).toString("hex")}` }),
  });

/**
 * Re-check an account's saved key.
 * @param cookie - Its Cookie header.
 * @returns The response.
 */
const recheck = async (cookie: string): Promise<Response> =>
  app.request("/api/v1/account/byok/keys/fal/check", { method: "POST", headers: { Cookie: cookie } });

/**
 * Point a model back at the platform key.
 * @param cookie - Whose session.
 * @returns The response.
 */
const choose = async (cookie: string): Promise<Response> =>
  app.request("/api/v1/account/byok/models/nano-banana-2", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ upstream: null }),
  });

describe("the BYOK key routes' own limits", () => {
  it("are configured in config/rate-limits.yaml", async () => {
    const actual = await vi.importActual<typeof RateLimitsModule>("@server/config/rate-limits.js");
    for (const action of LOWERED) {
      expect(actual.getRateLimit(action)).toEqual({ max: expect.any(Number), windowSeconds: expect.any(Number) });
    }
  });

  it("answers 429 to a third save in the window, without checking the key", async () => {
    const cookie = await signedIn();
    checkKey.mockClear();

    expect((await save(cookie)).status).toBe(200);
    expect((await save(cookie)).status).toBe(200);
    expect((await save(cookie)).status).toBe(429);
    expect(checkKey).toHaveBeenCalledTimes(2);
  });

  it("answers 429 to a third re-check in the window, without checking the key, and counts each account apart", async () => {
    const cookie = await signedIn();
    const other = await signedIn();
    expect((await save(cookie)).status).toBe(200);
    expect((await save(other)).status).toBe(200);
    checkKey.mockClear();

    expect((await recheck(cookie)).status).toBe(200);
    expect((await recheck(cookie)).status).toBe(200);
    expect((await recheck(cookie)).status).toBe(429);
    expect(checkKey).toHaveBeenCalledTimes(2);
    expect((await recheck(other)).status).toBe(200);
  });

  it("answers 429 to a third model choice in the window", async () => {
    const cookie = await signedIn();

    expect((await choose(cookie)).status).toBe(200);
    expect((await choose(cookie)).status).toBe(200);
    expect((await choose(cookie)).status).toBe(429);
  });
});
