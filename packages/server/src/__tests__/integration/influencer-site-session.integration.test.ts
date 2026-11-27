// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One sign-in for the official site and every influencer site (inner#2157
 * design §7.9 "全站会话", §7.5; §8 rows "全站登录（V11）" and the CORS case of
 * "来源判断"; acceptance V11, V12).
 *
 * With `COOKIE_DOMAIN` set, the session cookie is named
 * `breatic_site_session_<REDIS_KEY_PREFIX>` and carries
 * `Domain=<cookieDomainHost()>` (leading dot, spaces and upper case
 * removed), whether written by email sign-in or the Google callback. The
 * host-only cookie under the old name `breatic_session_<prefix>` is no longer
 * accepted, and any response to a request carrying it expires it. Signing out
 * on one host clears the one shared cookie and ends its session, so every
 * host is signed out. With `COOKIE_DOMAIN` empty, name and behaviour are as
 * before.
 *
 * Server CORS accepts the exact `ALLOWED_ORIGINS` entries plus every
 * registered influencer host, disabled ones included, with the first entry's
 * scheme and port.
 *
 * Real PostgreSQL and Redis; Google's token exchange and check are a double.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";
import type * as GoogleAuthLibrary from "google-auth-library";

const google = vi.hoisted(() => ({ getToken: vi.fn(), verifyIdToken: vi.fn() }));

vi.mock("google-auth-library", async (importOriginal) => {
  const { googleClientDouble } = await import("./google-redirect-harness.js");
  return googleClientDouble(await importOriginal<typeof GoogleAuthLibrary>(), google);
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

import crypto from "node:crypto";
import postgres from "postgres";
import { env, getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, googleRedirectLogin, setCookieLine } from "./google-redirect-harness.js";

loadLocales();

const OFFICIAL = "https://breatic.test";
const tag = crypto.randomBytes(4).toString("hex");
const ENABLED = { code: `ses-on-${tag}`, host: `son${tag}.partner.breatic.test` };
const DISABLED = { code: `ses-off-${tag}`, host: `soff${tag}.partner.breatic.test` };

let sql: ReturnType<typeof postgres>;
let app: Hono;
const createdEmails: string[] = [];

/**
 * Core for one region.
 * @param cookieDomain - `COOKIE_DOMAIN`.
 */
function initRegionCore(cookieDomain: string): void {
  initCore({
    ...process.env,
    EMAIL_BACKEND: "disabled",
    ALLOWED_ORIGINS: OFFICIAL,
    COOKIE_DOMAIN: cookieDomain,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
  });
}

/** The site-wide cookie's name. */
function siteName(): string {
  return `breatic_site_session_${env.REDIS_KEY_PREFIX}`;
}

/** The host-only cookie's name before this change. */
function oldName(): string {
  return `breatic_session_${env.REDIS_KEY_PREFIX}`;
}

beforeAll(async () => {
  initRegionCore("breatic.test");
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  // Registered before the first request: the trusted-origin host list is cached per process.
  await sql`INSERT INTO influencers (code, host) VALUES (${ENABLED.code}, ${ENABLED.host})`;
  await sql`INSERT INTO influencers (code, host, disabled_at) VALUES (${DISABLED.code}, ${DISABLED.host}, now())`;
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});

afterEach(async () => {
  const redis = getRedis();
  for (const pattern of [`${env.ENV}:ratelimit:register*`, `${env.ENV}:ratelimit:google*`, `${env.ENV}:ratelimit:login*`]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
  google.getToken.mockReset();
  google.verifyIdToken.mockReset();
  for (const email of createdEmails.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE email = ${email} AND deleted_at IS NULL`;
  }
  initRegionCore("breatic.test");
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * An account with a password, created from the official site.
 * @returns Its address and id.
 */
async function account(): Promise<{ email: string; id: string }> {
  const email = `site-session-${crypto.randomUUID()}@example.test`;
  createdEmails.push(email);
  const res = await app.request(`${OFFICIAL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: OFFICIAL },
    body: JSON.stringify({ email, password: "password1" }),
  });
  expect(res.status).toBe(201);
  const [row] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
  return { email, id: row!.id };
}

/**
 * Sign in with email on one site.
 * @param site - The site's origin.
 * @param email - The address.
 * @returns The response.
 */
async function login(site: string, email: string): Promise<Response> {
  const res = await app.request(`${site}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: site },
    body: JSON.stringify({ email, password: "password1" }),
  });
  expect(res.status).toBe(200);
  return res;
}

/**
 * The cookie value a Set-Cookie line carries.
 * @param line - The line.
 * @returns The value.
 */
function valueOf(line: string): string {
  return line.split(";")[0]!.split("=").slice(1).join("=");
}

/**
 * `GET /auth/me` on one site with a Cookie header.
 * @param site - The site's origin.
 * @param cookie - The Cookie header.
 * @returns The response.
 */
async function me(site: string, cookie: string): Promise<Response> {
  return await app.request(`${site}/api/v1/auth/me`, { headers: { Cookie: cookie, Origin: site } });
}

describe("site-wide session with COOKIE_DOMAIN set (V11)", () => {
  it("names the session cookie breatic_site_session_<prefix>", () => {
    expect(sessionCookieName()).toBe(siteName());
  });

  it("email sign-in writes the site-wide cookie with Domain, HttpOnly, SameSite=Lax and Path=/", async () => {
    const { email } = await account();
    const res = await login(`https://${ENABLED.host}`, email);
    const line = setCookieLine(res, siteName());
    expect(line).toMatch(/; Domain=breatic\.test(;|$)/);
    expect(line).toMatch(/; HttpOnly(;|$)/);
    expect(line).toMatch(/; SameSite=Lax(;|$)/i);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(setCookieLine(res, oldName())).toBeUndefined();
  });

  it("writes Domain as the bare lower-case host when COOKIE_DOMAIN has a leading dot, upper case and spaces", async () => {
    initRegionCore(" .Breatic.TEST ");
    const { email } = await account();
    const res = await login(OFFICIAL, email);
    expect(setCookieLine(res, siteName())).toMatch(/; Domain=breatic\.test(;|$)/);
  });

  it("the Google callback writes the same site-wide cookie with Domain", async () => {
    const email = `site-session-${crypto.randomUUID()}@example.test`;
    createdEmails.push(email);
    const { callback } = await googleRedirectLogin(app, google, {
      origin: `https://${ENABLED.host}`,
      page: "register",
      sub: crypto.randomUUID(),
      email,
    });
    const line = setCookieLine(callback, siteName());
    expect(line).toMatch(/; Domain=breatic\.test(;|$)/);
    expect(line).toMatch(/; HttpOnly(;|$)/);
    expect(setCookieLine(callback, oldName())).toBeUndefined();
  });

  it("a sign-in on an influencer site is a sign-in on the official site and on another influencer site", async () => {
    const { email, id } = await account();
    const token = valueOf(setCookieLine(await login(`https://${ENABLED.host}`, email), siteName())!);
    for (const site of [OFFICIAL, `https://${DISABLED.host}`]) {
      const res = await me(site, `${siteName()}=${token}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { id: string } }).data.id).toBe(id);
    }
  });

  it("does not accept the old host-only cookie and expires it in the response", async () => {
    const { id } = await account();
    const token = crypto.randomUUID();
    await setSession(getRedis(), token, id);
    const res = await me(OFFICIAL, `${oldName()}=${token}`);
    expect(res.status).toBe(401);
    const expiry = setCookieLine(res, oldName());
    expect(expiry).toMatch(/Max-Age=0/);
    expect(expiry).not.toMatch(/Domain=/i);
  });

  it("with both cookies, signs in by the site-wide one and still expires the old one", async () => {
    const { email, id } = await account();
    const oldToken = crypto.randomUUID();
    await setSession(getRedis(), oldToken, id);
    const token = valueOf(setCookieLine(await login(OFFICIAL, email), siteName())!);
    const res = await me(OFFICIAL, `${oldName()}=${oldToken}; ${siteName()}=${token}`);
    expect(res.status).toBe(200);
    expect(setCookieLine(res, oldName())).toMatch(/Max-Age=0/);
  });

  it("signing out on one site clears the shared cookie site-wide and every site is signed out", async () => {
    const { email } = await account();
    const site = `https://${ENABLED.host}`;
    const token = valueOf(setCookieLine(await login(site, email), siteName())!);
    const out = await app.request(`${site}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: `${siteName()}=${token}`, Origin: site },
    });
    expect(out.status).toBe(200);
    const cleared = setCookieLine(out, siteName());
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/; Domain=breatic\.test(;|$)/);
    for (const other of [OFFICIAL, site, `https://${DISABLED.host}`]) {
      expect((await me(other, `${siteName()}=${token}`)).status).toBe(401);
    }
  });

  it("a host still holding the old cookie is signed out after signing in and out on another host", async () => {
    const { email, id } = await account();
    const oldToken = crypto.randomUUID();
    await setSession(getRedis(), oldToken, id);
    const b = `https://${ENABLED.host}`;
    const token = valueOf(setCookieLine(await login(b, email), siteName())!);
    const out = await app.request(`${b}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: `${siteName()}=${token}`, Origin: b },
    });
    expect(out.status).toBe(200);
    // Host A: the shared cookie is gone; only its own old host-only cookie is left.
    expect((await me(OFFICIAL, `${oldName()}=${oldToken}`)).status).toBe(401);
  });
});

describe("COOKIE_DOMAIN empty keeps today's session cookie", () => {
  it("names, writes and accepts breatic_session_<prefix> without a Domain", async () => {
    initRegionCore("");
    expect(sessionCookieName()).toBe(oldName());
    const { email, id } = await account();
    const res = await login(OFFICIAL, email);
    const line = setCookieLine(res, oldName());
    expect(line).toMatch(/; HttpOnly(;|$)/);
    expect(line).not.toMatch(/Domain=/i);
    expect(setCookieLine(res, siteName())).toBeUndefined();
    const ok = await me(OFFICIAL, `${oldName()}=${valueOf(line!)}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { id: string } }).data.id).toBe(id);
    expect(setCookieLine(ok, oldName())).toBeUndefined();
  });
});

describe("server CORS for influencer sites (§7.5)", () => {
  /**
   * The origin a preflight from `origin` is allowed as.
   * @param origin - The requesting page's origin.
   * @returns `Access-Control-Allow-Origin` and `-Credentials`.
   */
  async function preflight(origin: string): Promise<{ origin: string | null; credentials: string | null }> {
    const res = await app.request(`${OFFICIAL}/api/v1/auth/me`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });
    return { origin: res.headers.get("access-control-allow-origin"), credentials: res.headers.get("access-control-allow-credentials") };
  }

  it("allows a registered influencer host with credentials", async () => {
    expect(await preflight(`https://${ENABLED.host}`)).toEqual({ origin: `https://${ENABLED.host}`, credentials: "true" });
  });

  it("V12 allows a disabled influencer's host", async () => {
    expect(await preflight(`https://${DISABLED.host}`)).toEqual({ origin: `https://${DISABLED.host}`, credentials: "true" });
  });

  it("allows the exact ALLOWED_ORIGINS entry", async () => {
    expect((await preflight(OFFICIAL)).origin).toBe(OFFICIAL);
  });

  it("does not allow a host in the influencer domain that nobody registered", async () => {
    expect((await preflight(`https://none${tag}.partner.breatic.test`)).origin).toBeNull();
  });

  it("does not allow a registered host on another scheme than the first ALLOWED_ORIGINS entry", async () => {
    expect((await preflight(`http://${ENABLED.host}`)).origin).toBeNull();
  });

  it("a simple request from a registered host carries the allowed origin", async () => {
    const res = await app.request(`${OFFICIAL}/api/v1/auth/options`, { headers: { Origin: `https://${ENABLED.host}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(`https://${ENABLED.host}`);
  });
});
