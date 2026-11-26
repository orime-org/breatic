// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Sign-up and sign-in analytics (inner#1442 design §4.5, §4.8) — real PG +
 * Redis. Events and the stored campaign source follow the signing-up
 * browser's consent cookie; without it neither leaves nor is kept.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";
import type * as GoogleAuthLibrary from "google-auth-library";

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

// Google's token endpoint and token check are answered here; the begin and
// callback routes run for real (inner#2157 design §7.9).
const google = vi.hoisted(() => ({ getToken: vi.fn(), verifyIdToken: vi.fn() }));
vi.mock("google-auth-library", async (io) => {
  const { googleClientDouble } = await import("./google-redirect-harness.js");
  return googleClientDouble(await io<typeof GoogleAuthLibrary>(), google);
});

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getUploadStatus,
  initServerAnalytics,
  loadLocales,
  setAdsConversionConfigForTest,
  resetServerAnalyticsForTest,
  type OutgoingEvent,
} from "@breatic/core";
import { CONSENT_COOKIE_NAME, CONSENT_REVISION } from "@breatic/shared";
import type { Hono } from "hono";

import { withPeer } from "../helpers/peer.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "./google-redirect-harness.js";
import { answerGoogleFrom, signInWithGoogle } from "./google-redirect-steps.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
const created: string[] = [];
const sent: OutgoingEvent[] = [];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
  initServerAnalytics({
    apiKey: "0123456789abcdef0123456789abcdef",
    createClient: () => ({ track: (event) => void sent.push(event), flush: async () => undefined }),
  });
});

afterEach(async () => {
  sent.splice(0);
  for (const id of created.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
  }
});

afterAll(async () => {
  resetServerAnalyticsForTest();
  await sql?.end({ timeout: 5 });
});

const AT = new Date().toISOString();
const ADS_CONFIG = {
  customerId: "1234567890",
  actions: { signup: "11" },
  credentials: { client_email: "svc@example.test", private_key: "key" },
};
const ATTRIBUTION = {
  first: { utm_source: "google", gclid: "click-1", landing_page: "/pricing?x=1", at: AT },
  last: { utm_source: "google", gclid: "click-1", at: AT },
};

/**
 * A consent cookie as the banner, or the regional default, writes it.
 * @param categories - Accepted categories.
 * @param source - Where both choices came from.
 * @returns A `Cookie` header value.
 */
function consentCookie(categories: string[], source = "banner"): string {
  const entry = { decidedAt: new Date().toISOString(), source };
  const data = { analytics: entry, ads: entry };
  return `${CONSENT_COOKIE_NAME}=${encodeURIComponent(JSON.stringify({ categories, revision: CONSENT_REVISION, data }))}`;
}

/**
 * Sign up by email through the app.
 * @param cookie - The browser's cookie header, if any.
 * @param gpc - Whether the browser sends `Sec-GPC: 1`.
 * @returns The new account's id.
 */
async function register(cookie?: string, gpc = false): Promise<string> {
  const res = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(gpc ? { "Sec-GPC": "1" } : {}),
    },
    body: JSON.stringify({
      email: `signup-analytics-${crypto.randomUUID()}@example.test`,
      password: "password1234",
      attribution: ATTRIBUTION,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { user: { id: string } } };
  created.push(body.data.user.id);
  return body.data.user.id;
}

/**
 * Read the stored campaign source.
 * @param userId - The account.
 * @returns The column value.
 */
async function storedAttribution(userId: string): Promise<unknown> {
  const rows = await sql<{ attribution: unknown }[]>`SELECT attribution FROM users WHERE id = ${userId}`;
  return rows[0]!.attribution;
}

describe("sign-up analytics", () => {
  it("keeps the source and reports the sign-up when the browser accepted analytics", async () => {
    const id = await register(consentCookie(["necessary", "analytics"]));
    expect(await storedAttribution(id)).toEqual({
      first: { utm_source: "google", gclid: "click-1", landing_page: "/pricing", at: AT },
      last: { utm_source: "google", gclid: "click-1", at: AT },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "signup_completed",
        user_id: id,
        insert_id: `signup:${id}`,
        event_properties: { method: "email" },
      }),
    ]);
  });

  it("keeps nothing and reports nothing without a consent cookie", async () => {
    const id = await register();
    expect(await storedAttribution(id)).toBeNull();
    expect(sent).toEqual([]);
  });

  it("keeps the source for an ads-only choice, queues the conversion, and sends no analytics event", async () => {
    setAdsConversionConfigForTest(ADS_CONFIG);
    try {
      const id = await register(consentCookie(["necessary", "ads"]));
      expect(await storedAttribution(id)).not.toBeNull();
      expect(sent).toEqual([]);
      expect(await getUploadStatus({ conversion: "signup", transactionId: `signup:${id}` })).toBe("queued");
    } finally {
      setAdsConversionConfigForTest(undefined);
    }
  });

  it("queues no conversion for a regional ads default from a browser that sends GPC", async () => {
    setAdsConversionConfigForTest(ADS_CONFIG);
    try {
      const id = await register(consentCookie(["necessary", "analytics", "ads"], "implicit"), true);
      expect(await getUploadStatus({ conversion: "signup", transactionId: `signup:${id}` })).toBeNull();
    } finally {
      setAdsConversionConfigForTest(undefined);
    }
  });

  it("queues the conversion for the visitor's own ads consent from a browser that sends GPC", async () => {
    setAdsConversionConfigForTest(ADS_CONFIG);
    try {
      const id = await register(consentCookie(["necessary", "ads"]), true);
      expect(await getUploadStatus({ conversion: "signup", transactionId: `signup:${id}` })).toBe("queued");
    } finally {
      setAdsConversionConfigForTest(undefined);
    }
  });

  it("reports an email login", async () => {
    const email = `signup-analytics-login-${crypto.randomUUID()}@example.test`;
    const reg = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password1234" }),
    });
    created.push(((await reg.json()) as { data: { user: { id: string } } }).data.user.id);

    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: consentCookie(["analytics"]) },
      body: JSON.stringify({ email, password: "password1234" }),
    });
    expect(res.status).toBe(200);
    expect(sent.map((e) => [e.event_type, e.event_properties])).toEqual([["login_completed", { method: "email" }]]);
  });
});

describe("the full-page Google sign-in", () => {
  beforeAll(() => {
    initCore({ ...process.env, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET });
    answerGoogleFrom(google);
  });

  afterAll(() => {
    initCore(process.env);
  });

  /** The site the sign-in starts from. */
  const SITE = "http://localhost:8000";

  it("follows the consent the begin request carried: source kept and sign-up reported, though the callback carries no consent cookie", async () => {
    const sub = crypto.randomUUID();
    const email = `signup-analytics-route-${crypto.randomUUID()}@gmail.com`;

    const first = await signInWithGoogle(
      app,
      { origin: SITE, cookie: consentCookie(["necessary", "analytics"]) },
      { sub, email },
      { attribution: ATTRIBUTION },
    );

    expect(first.location.searchParams.get("google")).toBe("created");
    const [row] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    created.push(row!.id);
    expect(await storedAttribution(row!.id)).toEqual({
      first: { utm_source: "google", gclid: "click-1", landing_page: "/pricing", at: AT },
      last: { utm_source: "google", gclid: "click-1", at: AT },
    });
    expect(sent.map((e) => [e.event_type, e.user_id, e.event_properties])).toEqual([
      ["signup_completed", row!.id, { method: "google" }],
    ]);
  });

  it("keeps nothing and reports nothing when the begin request carried no consent, even if the callback carries one", async () => {
    const email = `signup-analytics-route-${crypto.randomUUID()}@gmail.com`;

    const first = await signInWithGoogle(
      app,
      { origin: SITE },
      { sub: crypto.randomUUID(), email },
      { attribution: ATTRIBUTION },
      { cookie: consentCookie(["necessary", "analytics", "ads"]) },
    );

    expect(first.location.searchParams.get("google")).toBe("created");
    const [row] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    created.push(row!.id);
    expect(await storedAttribution(row!.id)).toBeNull();
    expect(sent).toEqual([]);
  });

  it("reports a later sign-in of the same Google account as a login only", async () => {
    const sub = crypto.randomUUID();
    const email = `signup-analytics-route-${crypto.randomUUID()}@gmail.com`;
    const consent = consentCookie(["necessary", "analytics"]);
    await signInWithGoogle(app, { origin: SITE, cookie: consent }, { sub, email }, {}, { cookie: consent });
    const [row] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    created.push(row!.id);
    sent.splice(0);

    const again = await signInWithGoogle(app, { origin: SITE, cookie: consent }, { sub, email }, { page: "login" }, { cookie: consent });

    expect(again.location.searchParams.get("google")).toBe("signed_in");
    expect(sent.map((e) => [e.event_type, e.event_properties])).toEqual([["login_completed", { method: "google" }]]);
  });
});
