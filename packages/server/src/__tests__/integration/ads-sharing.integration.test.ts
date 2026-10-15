// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's ad switch and the choices last seen while signed in
 * (inner#1442 design §4.4.6) — real PG + Redis.
 *
 * The switch is opened and closed through `PUT /users/me/ads-sharing`, closed
 * by any signed-in request that carries GPC, and closed on the person's
 * behalf by an operator; a signed-in request records the choices its cookie
 * holds. Events no browser is behind are decided from those two.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

// `ai` is stubbed so the app's module graph reaches no network.
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
import {
  accountOnlyConsent,
  adsAllowedFor,
  eraseAccountAnalytics,
  getAdsSharing,
  getRedis,
  initCore,
  loadLocales,
  sessionCookieName,
  setAdsSharing,
  setSession,
} from "@breatic/core";
import { CONSENT_COOKIE_NAME, CONSENT_REVISION } from "@breatic/shared";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
const created: string[] = [];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await sql`UPDATE users SET deleted_at = coalesce(deleted_at, now()) WHERE id = ${id}`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Inserts an account with nothing on record.
 * @returns The account's id.
 */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`ads-sharing-${crypto.randomUUID()}@example.test`}, true, 'base')
    RETURNING id
  `;
  created.push(rows[0]!.id);
  return rows[0]!.id;
}

type Source = "banner" | "settings" | "implicit" | "gpc";

/** One category's entry in the consent cookie. */
interface CookieChoice {
  readonly value: boolean;
  readonly source: Source;
  readonly revision?: number;
}

/**
 * The consent cookie a browser holding these choices sends.
 * @param choices - Each category's choice; a missing one is unset.
 * @param choices.analytics - The analytics choice.
 * @param choices.ads - The ads choice.
 * @returns The cookie pair.
 */
function consentCookie(choices: { analytics?: CookieChoice; ads?: CookieChoice }): string {
  const entry = (c: CookieChoice) => ({ decidedAt: new Date(Date.now() - 60_000).toISOString(), source: c.source });
  const categories = ["necessary"];
  const data: Record<string, unknown> = {};
  for (const category of ["analytics", "ads"] as const) {
    const choice = choices[category];
    if (!choice) continue;
    if (choice.value) categories.push(category);
    data[category] = entry(choice);
  }
  const revision = choices.analytics?.revision ?? choices.ads?.revision ?? CONSENT_REVISION;
  return `${CONSENT_COOKIE_NAME}=${encodeURIComponent(JSON.stringify({ categories, revision, data }))}`;
}

/**
 * Sends a signed-in request.
 * @param userId - The account.
 * @param init - Path, method, body, the cookie's choices, and whether it sends GPC.
 * @param init.path - The path under `/api/v1`; the ad switch by default.
 * @param init.method - The method.
 * @param init.body - The JSON body.
 * @param init.choices - The choices this browser's consent cookie holds.
 * @param init.gpc - Whether the request carries `Sec-GPC: 1`.
 * @returns The response.
 */
async function call(
  userId: string,
  init: {
    path?: string;
    method?: string;
    body?: unknown;
    choices?: { analytics?: CookieChoice; ads?: CookieChoice };
    gpc?: boolean;
  } = {},
): Promise<Response> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  const cookies = [`${sessionCookieName()}=${token}`];
  if (init.choices) cookies.push(consentCookie(init.choices));
  return app.request(`/api/v1${init.path ?? "/users/me/ads-sharing"}`, {
    method: init.method ?? "GET",
    headers: {
      Cookie: cookies.join("; "),
      "Content-Type": "application/json",
      ...(init.gpc ? { "Sec-GPC": "1" } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/**
 * The account's ad switch and seen choices as stored.
 * @param userId - The account.
 * @returns The three columns.
 */
async function stored(userId: string): Promise<{ at: Date | null; source: string | null; seen: unknown }> {
  const rows = await sql<{ at: Date | null; source: string | null; seen: unknown }[]>`
    SELECT ads_opted_out_at AS at, ads_opt_out_source AS source, consent_seen AS seen FROM users WHERE id = ${userId}
  `;
  return rows[0]!;
}

const banner = (value: boolean): CookieChoice => ({ value, source: "banner" });

describe("GET /users/me/ads-sharing", () => {
  it("answers that a new account has not opted out", async () => {
    const id = await insertUser();
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { optedOut: false, source: null } });
  });

  it("refuses a request without a session", async () => {
    const res = await app.request("/api/v1/users/me/ads-sharing");
    expect(res.status).toBe(401);
  });
});

describe("PUT /users/me/ads-sharing", () => {
  it("closes the switch from settings and answers the new state", async () => {
    const id = await insertUser();
    const res = await call(id, { method: "PUT", body: { allowed: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { optedOut: true, source: "settings" } });
    const row = await stored(id);
    expect(row.at).not.toBeNull();
    expect(row.source).toBe("settings");
  });

  it("keeps the time and source of a switch already closed", async () => {
    const id = await insertUser();
    await setAdsSharing(id, { allowed: false, source: "request" });
    const before = await stored(id);
    const res = await call(id, { method: "PUT", body: { allowed: false } });
    expect(await res.json()).toEqual({ data: { optedOut: true, source: "request" } });
    expect(await stored(id)).toMatchObject({ at: before.at, source: "request" });
  });

  it("opens a closed switch when the request carries no GPC", async () => {
    const id = await insertUser();
    await setAdsSharing(id, { allowed: false, source: "gpc" });
    const res = await call(id, { method: "PUT", body: { allowed: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { optedOut: false, source: null } });
    expect(await stored(id)).toMatchObject({ at: null, source: null });
  });

  it("refuses to open the switch from a browser that sends GPC, which closes it instead", async () => {
    const id = await insertUser();
    const res = await call(id, { method: "PUT", body: { allowed: true }, gpc: true });
    expect(res.status).toBe(409);
    expect(await stored(id)).toMatchObject({ source: "gpc" });
  });

  it("rejects a malformed body and changes nothing", async () => {
    const id = await insertUser();
    for (const bad of [{}, { allowed: "no" }, { allowed: false, source: "gpc" }]) {
      const res = await call(id, { method: "PUT", body: bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await stored(id)).toMatchObject({ at: null, source: null });
  });
});

describe("a signed-in request", () => {
  it("closes the account's switch when it carries GPC, on any signed-in route", async () => {
    const id = await insertUser();
    const res = await call(id, { path: "/auth/me", gpc: true });
    expect(res.status).toBe(200);
    const first = await stored(id);
    expect(first).toMatchObject({ source: "gpc" });
    expect(first.at).not.toBeNull();
    await call(id, { path: "/auth/me", gpc: true });
    expect((await stored(id)).at).toEqual(first.at);
  });

  it("leaves a switch already closed from settings as it is when GPC arrives", async () => {
    const id = await insertUser();
    await setAdsSharing(id, { allowed: false, source: "settings" });
    await call(id, { path: "/auth/me", gpc: true });
    expect(await stored(id)).toMatchObject({ source: "settings" });
  });

  it("records the choices its cookie holds as the ones last seen", async () => {
    const id = await insertUser();
    await call(id, { path: "/auth/me", choices: { analytics: banner(true), ads: { value: false, source: "settings" } } });
    expect((await stored(id)).seen).toEqual({
      analytics: { value: true, revision: CONSENT_REVISION },
      ads: { value: false, revision: CONSENT_REVISION },
    });
  });

  it("replaces the seen choices whole when they differ, leaving out a regional default", async () => {
    const id = await insertUser();
    await call(id, { path: "/auth/me", choices: { analytics: banner(true), ads: banner(true) } });
    await call(id, { path: "/auth/me", choices: { analytics: { value: true, source: "implicit" }, ads: banner(false) } });
    expect((await stored(id)).seen).toEqual({ ads: { value: false, revision: CONSENT_REVISION } });
  });

  it("records nothing for a cookie holding only regional defaults, or no cookie", async () => {
    const id = await insertUser();
    await call(id, { path: "/auth/me", choices: { analytics: banner(true) } });
    await call(id, { path: "/auth/me", choices: { analytics: { value: true, source: "implicit" } } });
    await call(id, { path: "/auth/me" });
    expect((await stored(id)).seen).toEqual({ analytics: { value: true, revision: CONSENT_REVISION } });
  });
});

describe("events no browser is behind", () => {
  it("follow the choices last seen while the switch is open", async () => {
    const id = await insertUser();
    expect(await accountOnlyConsent(id)).toEqual({ analytics: false, ads: false });
    await call(id, { path: "/auth/me", choices: { analytics: banner(true), ads: banner(true) } });
    expect(await accountOnlyConsent(id)).toEqual({ analytics: true, ads: true });
    expect(await adsAllowedFor(id, null)).toBe(true);
    await setAdsSharing(id, { allowed: false, source: "settings" });
    expect(await accountOnlyConsent(id)).toEqual({ analytics: true, ads: false });
    expect(await adsAllowedFor(id, null)).toBe(false);
  });

  it("count a seen choice under a revision no longer in force as none", async () => {
    const id = await insertUser();
    const old = CONSENT_REVISION - 1;
    await sql`UPDATE users SET consent_seen = ${sql.json({
      analytics: { value: true, revision: old },
      ads: { value: true, revision: old },
    })} WHERE id = ${id}`;
    expect(await accountOnlyConsent(id)).toEqual({ analytics: false, ads: false });
  });

  it("are never measured for a deleted or missing account", async () => {
    const id = await insertUser();
    await call(id, { path: "/auth/me", choices: { analytics: banner(true), ads: banner(true) } });
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await accountOnlyConsent(id)).toEqual({ analytics: false, ads: false });
    expect(await adsAllowedFor(id, null)).toBe(false);
    expect(await adsAllowedFor(crypto.randomUUID(), null)).toBe(false);
  });
});

describe("adsAllowedFor with a browser", () => {
  it("weighs the browser's consent and GPC with the account's current switch", async () => {
    const id = await insertUser();
    expect(await adsAllowedFor(id, { consent: true, gpc: false })).toBe(true);
    expect(await adsAllowedFor(id, { consent: true, gpc: true })).toBe(false);
    expect(await adsAllowedFor(id, { consent: false, gpc: false })).toBe(false);
    await setAdsSharing(id, { allowed: false, source: "gpc" });
    expect(await adsAllowedFor(id, { consent: true, gpc: false })).toBe(false);
  });
});

describe("setAdsSharing on the person's behalf", () => {
  it("closes the switch with source request and answers the state", async () => {
    const id = await insertUser();
    expect(await setAdsSharing(id, { allowed: false, source: "request" })).toEqual({ optedOut: true, source: "request" });
    expect(await getAdsSharing(id)).toEqual({ optedOut: true, source: "request" });
  });

  it("answers null for a missing or deleted account and writes nothing", async () => {
    expect(await setAdsSharing(crypto.randomUUID(), { allowed: false, source: "request" })).toBeNull();
    const id = await insertUser();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await setAdsSharing(id, { allowed: false, source: "request" })).toBeNull();
    expect(await getAdsSharing(id)).toBeNull();
    expect(await stored(id)).toMatchObject({ at: null, source: null });
  });
});

describe("eraseAccountAnalytics", () => {
  /**
   * An account with its switch closed, choices seen, and consent kept on an
   * order, an upload ticket and an ad upload.
   * @returns Its id.
   */
  async function accountWithConsent(): Promise<string> {
    const id = await insertUser();
    await sql`UPDATE users SET ads_opted_out_at = now(), ads_opt_out_source = 'gpc',
      consent_seen = ${sql.json({ ads: { value: true, revision: CONSENT_REVISION } })} WHERE id = ${id}`;
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
    `;
    await sql`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted, metadata)
      VALUES (${source!.id}, ${id}, 1000, 'completed', 1000,
              ${sql.json({ locale: "en", analyticsConsent: { analytics: true, ads: true }, adsBrowser: { consent: true, gpc: false } })})
    `;
    const [studio] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${id}, ${`erase-${crypto.randomUUID().slice(0, 8)}`}, 'team', 'Team') RETURNING id
    `;
    await sql`
      INSERT INTO upload_grants (user_id, studio_id, storage_key, declared_size, expires_at, analytics_consent)
      VALUES (${id}, ${studio!.id}, ${`k/${crypto.randomUUID()}`}, 1, now() + interval '1 hour',
              ${sql.json({ analytics: true, ads: true })})
    `;
    const job = { kind: "conversion", userId: id, browser: { consent: true, gpc: false } };
    await sql`
      INSERT INTO ads_conversion_uploads (conversion, transaction_id, payment_id, status, job)
      VALUES ('signup', ${`signup:${id}`}, null, 'uploaded', ${sql.json(job)})
    `;
    return id;
  }

  it("refuses accounts that are not deleted, and changes nothing", async () => {
    const live = await accountWithConsent();
    const deleted = await accountWithConsent();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${deleted}`;
    expect(await eraseAccountAnalytics([live, deleted])).toEqual({ notDeleted: [live] });
    expect(await stored(deleted)).toMatchObject({ source: "gpc" });
  });

  it("clears the switch, the seen choices and every consent snapshot of deleted accounts", async () => {
    const id = await accountWithConsent();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
    expect(await eraseAccountAnalytics([id])).toEqual({ notDeleted: [] });
    expect(await stored(id)).toEqual({ at: null, source: null, seen: null });
    const [payment] = await sql<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM payments WHERE user_id = ${id}`;
    expect(payment!.metadata).toEqual({ locale: "en" });
    const [grant] = await sql<{ c: unknown }[]>`SELECT analytics_consent AS c FROM upload_grants WHERE user_id = ${id}`;
    expect(grant!.c).toBeNull();
    const [upload] = await sql<{ job: Record<string, unknown> }[]>`
      SELECT job FROM ads_conversion_uploads WHERE transaction_id = ${`signup:${id}`}
    `;
    expect(upload!.job.browser).toBeNull();
  });
});
