// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sign-up and sign-in analytics (inner#1442 design §4.5, §4.8) — real PG +
 * Redis. Events and the stored campaign source follow the signing-up
 * browser's consent cookie; without it neither leaves nor is kept.
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

// Google's token check is answered here; the rest of the route runs for real.
const google = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({ verifyIdToken: google.verifyIdToken })),
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getUploadStatus,
  initServerAnalytics,
  loadLocales,
  setAdsConversionConfigForTest,
  resetServerAnalyticsForTest,
  runWithConsent,
  type OutgoingEvent,
} from "@breatic/core";
import { CONSENT_COOKIE_NAME, CONSENT_REVISION } from "@breatic/shared";
import type { Hono } from "hono";

import { withPeer } from "../helpers/peer.js";

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

  it("reports a first Google sign-in as a sign-up and later ones as logins", async () => {
    const { authService } = await import("@server/modules");
    const googleId = crypto.randomUUID();
    const email = `signup-analytics-google-${crypto.randomUUID()}@example.test`;
    const consent = { analytics: true, ads: false };

    const first = await runWithConsent(consent, () => authService.loginOrCreateGoogle(googleId, email));
    created.push(first.user.id);
    expect(first.created).toBe(true);
    const again = await runWithConsent(consent, () => authService.loginOrCreateGoogle(googleId, email));
    expect(again.created).toBe(false);

    expect(sent.map((e) => [e.event_type, e.event_properties])).toEqual([["signup_completed", { method: "google" }]]);
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

describe("the Google sign-in route", () => {
  beforeAll(() => {
    initCore({ ...process.env, GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com" });
  });

  afterAll(() => {
    initCore(process.env);
  });

  it("reports the first sign-in as a sign-up only, with its source kept, and a later one as a login", async () => {
    const sub = crypto.randomUUID();
    const email = `signup-analytics-route-${crypto.randomUUID()}@example.test`;
    google.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ iss: "https://accounts.google.com", sub, email, email_verified: true }),
    });
    const signIn = () =>
      app.request("/api/v1/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: consentCookie(["necessary", "analytics"]) },
        body: JSON.stringify({ credential: "signed-token", attribution: ATTRIBUTION }),
      });

    const first = await signIn();
    expect(first.status).toBe(200);
    const { user, created: wasCreated } = ((await first.json()) as { data: { user: { id: string }; created: boolean } }).data;
    created.push(user.id);
    expect(wasCreated).toBe(true);
    expect(sent.map((e) => e.event_type)).toEqual(["signup_completed"]);
    expect(await storedAttribution(user.id)).not.toBeNull();

    sent.splice(0);
    expect((await signIn()).status).toBe(200);
    expect(sent.map((e) => [e.event_type, e.event_properties])).toEqual([["login_completed", { method: "google" }]]);
  });
});
