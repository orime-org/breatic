// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whether a saved key can read the actual costs of its calls (inner#1953, design 3.6): a fal key's check also probes the
 * billing events actual costs are read from, and what it found is kept with the key's last check and answered per key
 * by `GET /api/v1/account/byok`, so the dialog can say "this key cannot read actual costs". An upstream with no such
 * probe answers null. `provider().checkKey` is stubbed at the provider instance, as in `byok-account-routes`.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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

import crypto, { randomBytes } from "node:crypto";
import postgres from "postgres";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { initProvider } from "@breatic/domain";
import type { Hono } from "hono";

const SECRET = randomBytes(32);
const checkKey = vi.fn<(upstream: string, key: string) => Promise<Record<string, unknown>>>();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore({ ...process.env, PROVIDER_KEY_SECRET_ID: "t1", PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }) });
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
    INSERT INTO users (email, email_verified) VALUES (${`byok-costs-${crypto.randomUUID().slice(0, 8)}@test.local`}, true) RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Send a request under `/api/v1/account/byok`.
 * @param cookie - The account's Cookie header.
 * @param method - The method.
 * @param path - The path under the settings.
 * @param body - The JSON body, if any.
 * @returns The response.
 */
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/v1/account/byok${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * The account's saved keys, by upstream.
 * @param cookie - The account's Cookie header.
 * @returns Each key's `costsReadable`.
 */
async function readable(cookie: string): Promise<Record<string, unknown>> {
  const { data } = (await (await call(cookie, "GET", "")).json()) as { data: { keys: { upstream: string; costsReadable?: unknown }[] } };
  return Object.fromEntries(data.keys.map((k) => [k.upstream, k.costsReadable]));
}

describe("whether a saved key can read actual costs", () => {
  it("is kept from the check that saved it and answered per key, null where the upstream has no such probe", async () => {
    const cookie = await signedIn();
    checkKey.mockImplementation(async (upstream) =>
      upstream === "fal" ? { connected: true, balance: "forbidden", costsReadable: false } : { connected: true, balance: { amount: 3, currency: "USD" } });

    expect((await call(cookie, "PUT", "/keys/fal", { key: `fal-${crypto.randomBytes(12).toString("hex")}` })).status).toBe(200);
    expect((await call(cookie, "PUT", "/keys/wavespeed", { key: `ws-${crypto.randomBytes(12).toString("hex")}` })).status).toBe(200);

    expect(await readable(cookie)).toEqual({ fal: false, wavespeed: null });
  });

  it("follows a later check of the key", async () => {
    const cookie = await signedIn();
    checkKey.mockImplementation(async () => ({ connected: true, balance: "forbidden", costsReadable: false }));
    expect((await call(cookie, "PUT", "/keys/fal", { key: `fal-${crypto.randomBytes(12).toString("hex")}` })).status).toBe(200);
    checkKey.mockImplementation(async () => ({ connected: true, balance: { amount: 9, currency: "USD" }, costsReadable: true }));

    expect((await call(cookie, "POST", "/keys/fal/check")).status).toBe(200);

    expect(await readable(cookie)).toEqual({ fal: true });
  });
});
