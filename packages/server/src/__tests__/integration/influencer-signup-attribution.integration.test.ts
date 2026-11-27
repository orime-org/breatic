// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Influencer attribution at sign-up (inner#2157 design §7.2, §7.9; acceptance
 * V1, V2, V3, V8, V12). Every new account's `users.influencer_code` is the
 * code of the influencer whose site the sign-up request came from, read from
 * the request's `Origin`:
 *
 * - `POST /auth/register` with no mail backend: that request's `Origin`;
 * - `POST /auth/register/verify` with a mail backend: the second step's
 *   `Origin`, not the first step's;
 * - Google: the `Origin` of `POST /auth/google/begin`, kept server-side
 *   until the callback creates the account.
 *
 * An unknown host, a disabled influencer's host, the official site and a
 * request without `Origin` all record `official`. Signing in to an existing
 * account (email, Google, Google linking an email account) never changes its
 * attribution, and disabling an influencer leaves the accounts already
 * recorded under it untouched.
 *
 * Real PostgreSQL and Redis; the mail is captured and Google's token
 * exchange and token check are answered by a double.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";
import type * as GoogleAuthLibrary from "google-auth-library";

const sent = vi.hoisted(() => ({ mails: [] as { to: string; text: string }[] }));
const google = vi.hoisted(() => ({ getToken: vi.fn(), verifyIdToken: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendMail: async (mail: { to: string; text: string }) => {
      sent.mails.push(mail);
      return { status: "sent" };
    },
  };
});

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
import { env, getRedis, initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, cookiePair, googleRedirectLogin } from "./google-redirect-harness.js";

loadLocales();

const OFFICIAL = "https://breatic.test";
const tag = crypto.randomBytes(4).toString("hex");
/** An enabled influencer. */
const ENABLED = { code: `att-on-${tag}`, host: `on${tag}.partner.breatic.test` };
/** An influencer disabled before any case runs. */
const DISABLED = { code: `att-off-${tag}`, host: `off${tag}.partner.breatic.test` };
/** An influencer the cases disable and enable again. */
const TOGGLED = { code: `att-tg-${tag}`, host: `tg${tag}.partner.breatic.test` };
/** A host in the influencer domain that nobody registered. */
const UNKNOWN_HOST = `none${tag}.partner.breatic.test`;

let sql: ReturnType<typeof postgres>;
let app: Hono;
const createdEmails: string[] = [];

/**
 * Core configured like a production region: the official site first in
 * `ALLOWED_ORIGINS`, a site-wide cookie domain and Google sign-in configured.
 * @param emailBackend - `console` for the two-step sign-up, `disabled` for the one-step one.
 */
function initRegionCore(emailBackend: "console" | "disabled"): void {
  initCore({
    ...process.env,
    EMAIL_BACKEND: emailBackend,
    ALLOWED_ORIGINS: OFFICIAL,
    COOKIE_DOMAIN: "breatic.test",
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
  });
}

beforeAll(async () => {
  initRegionCore("disabled");
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  // Registered before the first request: the trusted-origin host list is cached per process.
  await sql`INSERT INTO influencers (code, host) VALUES (${ENABLED.code}, ${ENABLED.host}), (${TOGGLED.code}, ${TOGGLED.host})`;
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
  sent.mails.length = 0;
  google.getToken.mockReset();
  google.verifyIdToken.mockReset();
  await sql`UPDATE influencers SET disabled_at = NULL WHERE code = ${TOGGLED.code}`;
  for (const email of createdEmails.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE email = ${email} AND deleted_at IS NULL`;
  }
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A fresh address this suite owns.
 * @param domain - The address's domain; `gmail.com` makes Google's word on it authoritative.
 * @returns The address.
 */
function freshEmail(domain = "example.test"): string {
  const email = `influencer-attr-${crypto.randomUUID()}@${domain}`;
  createdEmails.push(email);
  return email;
}

/**
 * The live account's recorded influencer code.
 * @param email - The account's address.
 * @returns Its `influencer_code`.
 */
async function codeOf(email: string): Promise<string> {
  const rows = await sql<{ influencer_code: string }[]>`
    SELECT influencer_code FROM users WHERE email = ${email} AND deleted_at IS NULL`;
  expect(rows).toHaveLength(1);
  return rows[0]!.influencer_code;
}

/**
 * POST a JSON auth request.
 * @param path - Path under `/api/v1/auth`.
 * @param body - JSON body.
 * @param headers - Extra headers (`Origin`, `Cookie`).
 * @returns The response.
 */
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request(`/api/v1/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * The six-digit code in the most recent mail.
 * @returns The code.
 */
function lastCode(): string {
  const match = /\b(\d{6})\b/.exec(sent.mails.at(-1)?.text ?? "");
  if (!match) throw new Error("no code in the last mail");
  return match[1]!;
}

/**
 * Create an account through the one-step sign-up from a given site.
 * @param origin - The request's `Origin`, or null for none.
 * @returns The account's address.
 */
async function registerAt(origin: string | null): Promise<string> {
  initRegionCore("disabled");
  const email = freshEmail();
  const res = await post("/register", { email, password: "password1" }, origin === null ? {} : { Origin: origin });
  expect(res.status).toBe(201);
  return email;
}

describe("one-step email sign-up (POST /auth/register, no mail backend)", () => {
  it("V1 records the influencer whose site sent the request", async () => {
    const email = await registerAt(`https://${ENABLED.host}`);
    expect(await codeOf(email)).toBe(ENABLED.code);
  });

  it("V2 records official for a sign-up from the official site", async () => {
    expect(await codeOf(await registerAt(OFFICIAL))).toBe("official");
  });

  it("records official for a request without Origin", async () => {
    expect(await codeOf(await registerAt(null))).toBe("official");
  });

  it("records official for a host in the influencer domain that nobody registered", async () => {
    expect(await codeOf(await registerAt(`https://${UNKNOWN_HOST}`))).toBe("official");
  });

  it("V12 records official for a sign-up from a disabled influencer's site", async () => {
    expect(await codeOf(await registerAt(`https://${DISABLED.host}`))).toBe("official");
  });

  it("V12 records official while disabled, the influencer again once re-enabled, and never moves earlier accounts", async () => {
    const before = await registerAt(`https://${TOGGLED.host}`);
    expect(await codeOf(before)).toBe(TOGGLED.code);

    await sql`UPDATE influencers SET disabled_at = now() WHERE code = ${TOGGLED.code}`;
    const during = await registerAt(`https://${TOGGLED.host}`);
    expect(await codeOf(during)).toBe("official");
    expect(await codeOf(before)).toBe(TOGGLED.code);

    await sql`UPDATE influencers SET disabled_at = NULL WHERE code = ${TOGGLED.code}`;
    const after = await registerAt(`https://${TOGGLED.host}`);
    expect(await codeOf(after)).toBe(TOGGLED.code);
    expect(await codeOf(during)).toBe("official");
  });
});

describe("two-step email sign-up (POST /auth/register/verify)", () => {
  /**
   * Start a sign-up from one site and finish it from another.
   * @param startOrigin - The first step's `Origin`, or null.
   * @param verifyOrigin - The second step's `Origin`, or null.
   * @returns The account's address.
   */
  async function signUp(startOrigin: string | null, verifyOrigin: string | null): Promise<string> {
    initRegionCore("console");
    const email = freshEmail();
    const started = await post("/register", { email, password: "password1" }, startOrigin === null ? {} : { Origin: startOrigin });
    expect(started.status).toBe(202);
    const ticket = cookiePair(started, "breatic_signup_")!;
    const verified = await post(
      "/register/verify",
      { code: lastCode() },
      { Cookie: ticket, ...(verifyOrigin === null ? {} : { Origin: verifyOrigin }) },
    );
    expect(verified.status).toBe(201);
    return email;
  }

  it("V1 records the influencer named by the verifying request's Origin", async () => {
    expect(await codeOf(await signUp(OFFICIAL, `https://${ENABLED.host}`))).toBe(ENABLED.code);
  });

  it("takes the Origin of the second step, not the first", async () => {
    expect(await codeOf(await signUp(`https://${ENABLED.host}`, OFFICIAL))).toBe("official");
  });

  it("V2 records official when both steps come from the official site", async () => {
    expect(await codeOf(await signUp(OFFICIAL, OFFICIAL))).toBe("official");
  });

  it("V12 records official when the verifying site is a disabled influencer's", async () => {
    expect(await codeOf(await signUp(`https://${DISABLED.host}`, `https://${DISABLED.host}`))).toBe("official");
  });
});

describe("Google sign-up (Origin of POST /auth/google/begin)", () => {
  it("V1 records the influencer whose site began the sign-in and returns the browser there", async () => {
    initRegionCore("disabled");
    const email = freshEmail();
    const origin = `https://${ENABLED.host}`;
    const { location } = await googleRedirectLogin(app, google, { origin, page: "register", sub: crypto.randomUUID(), email });
    expect(`${location.origin}${location.pathname}`).toBe(`${origin}/register`);
    expect(location.searchParams.get("google")).toBe("created");
    expect(await codeOf(email)).toBe(ENABLED.code);
  });

  it("V2 records official for a Google sign-up begun on the official site", async () => {
    initRegionCore("disabled");
    const email = freshEmail();
    const { location } = await googleRedirectLogin(app, google, { origin: OFFICIAL, page: "register", sub: crypto.randomUUID(), email });
    expect(location.searchParams.get("google")).toBe("created");
    expect(await codeOf(email)).toBe("official");
  });

  it("V12 records official for a Google sign-up begun on a disabled influencer's site", async () => {
    initRegionCore("disabled");
    const email = freshEmail();
    const origin = `https://${DISABLED.host}`;
    const { location } = await googleRedirectLogin(app, google, { origin, page: "register", sub: crypto.randomUUID(), email });
    expect(`${location.origin}${location.pathname}`).toBe(`${origin}/register`);
    expect(location.searchParams.get("google")).toBe("created");
    expect(await codeOf(email)).toBe("official");
  });

  it("V12 records the influencer again once its site is re-enabled", async () => {
    initRegionCore("disabled");
    const origin = `https://${TOGGLED.host}`;
    await sql`UPDATE influencers SET disabled_at = now() WHERE code = ${TOGGLED.code}`;
    const during = freshEmail();
    await googleRedirectLogin(app, google, { origin, page: "register", sub: crypto.randomUUID(), email: during });
    expect(await codeOf(during)).toBe("official");

    await sql`UPDATE influencers SET disabled_at = NULL WHERE code = ${TOGGLED.code}`;
    const after = freshEmail();
    await googleRedirectLogin(app, google, { origin, page: "register", sub: crypto.randomUUID(), email: after });
    expect(await codeOf(after)).toBe(TOGGLED.code);
  });
});

describe("signing in never changes an existing account's attribution (V3)", () => {
  it("an official account signing in with email from an influencer's site stays official", async () => {
    const email = await registerAt(OFFICIAL);
    const res = await post("/login", { email, password: "password1" }, { Origin: `https://${ENABLED.host}` });
    expect(res.status).toBe(200);
    expect(await codeOf(email)).toBe("official");
  });

  it("an influencer's account signing in with email from the official site keeps its influencer", async () => {
    const email = await registerAt(`https://${ENABLED.host}`);
    const res = await post("/login", { email, password: "password1" }, { Origin: OFFICIAL });
    expect(res.status).toBe(200);
    expect(await codeOf(email)).toBe(ENABLED.code);
  });

  it("an official Google account signing in from an influencer's site stays official", async () => {
    initRegionCore("disabled");
    const email = freshEmail();
    const sub = crypto.randomUUID();
    await googleRedirectLogin(app, google, { origin: OFFICIAL, page: "register", sub, email });
    expect(await codeOf(email)).toBe("official");

    const { location } = await googleRedirectLogin(app, google, { origin: `https://${ENABLED.host}`, page: "login", sub, email });
    expect(location.searchParams.get("google")).toBe("signed_in");
    expect(await codeOf(email)).toBe("official");
  });

  it("Google linking an existing official email account from an influencer's site keeps it official and creates no account", async () => {
    initRegionCore("disabled");
    const email = freshEmail("gmail.com");
    const res = await post("/register", { email, password: "password1" }, { Origin: OFFICIAL });
    expect(res.status).toBe(201);
    const sub = crypto.randomUUID();

    const { location } = await googleRedirectLogin(app, google, { origin: `https://${ENABLED.host}`, page: "login", sub, email });
    expect(location.searchParams.get("google")).toBe("signed_in");
    const rows = await sql<{ influencer_code: string; google_id: string | null }[]>`
      SELECT influencer_code, google_id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    expect(rows).toEqual([{ influencer_code: "official", google_id: sub }]);
  });
});

describe("existing data (V8)", () => {
  it("an account written without naming an influencer is official", async () => {
    const email = freshEmail();
    await sql`INSERT INTO users (email) VALUES (${email})`;
    expect(await codeOf(email)).toBe("official");
  });
});
