// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The sign-up routes with an email backend enabled (#287): register answers
 * with a code sent and a ticket cookie, verify turns a matching code into an
 * account and a session. Real PostgreSQL and Redis; the mail is captured.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

const sent = vi.hoisted(() => ({ mails: [] as { to: string; text: string }[] }));

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
import { initCore, loadLocales, sessionCookieName } from "@breatic/core";
import type { Hono } from "hono";

loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
const createdEmails: string[] = [];

beforeAll(async () => {
  initCore({ ...process.env, EMAIL_BACKEND: "console" });
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(async () => {
  sent.mails.length = 0;
  for (const email of createdEmails.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE email = ${email} AND deleted_at IS NULL`;
  }
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/** A fresh address this suite owns. */
function freshEmail(): string {
  const email = `signup-route-${crypto.randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
}

/** The six-digit code in the most recent mail. */
function lastCode(): string {
  const match = /\b(\d{6})\b/.exec(sent.mails.at(-1)?.text ?? "");
  if (!match) throw new Error("no code in the last mail");
  return match[1]!;
}

/** Every Set-Cookie header on a response. */
function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** The `name=value` pair of the cookie whose name starts with `prefix`. */
function cookiePair(res: Response, prefix: string): string | undefined {
  return setCookies(res)
    .find((c) => c.startsWith(prefix))
    ?.split(";")[0];
}

/** POST a JSON body, optionally with a Cookie header. */
function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(`/api/v1/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("GET /auth/options", () => {
  it("tells the page that sign-up needs a code", async () => {
    const res = await app.request("/api/v1/auth/options");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { emailVerification: true } });
  });
});

describe("POST /auth/register with email enabled", () => {
  it("answers 202, sets an httpOnly ticket cookie scoped to the register routes, and signs nobody in", async () => {
    const email = freshEmail();
    const res = await post("/register", { email, password: "password1" });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      data: { status: "code_sent", expiresInSeconds: 600, resendAfterSeconds: 60 },
    });
    const ticket = setCookies(res).find((c) => c.startsWith("breatic_signup_"));
    expect(ticket).toBeDefined();
    expect(ticket).toMatch(/HttpOnly/i);
    expect(ticket).toMatch(/Path=\/api\/v1\/auth\/register/);
    expect(ticket).toMatch(/SameSite=Lax/i);
    expect(ticket).toMatch(/Max-Age=600/);
    expect(cookiePair(res, sessionCookieName())).toBeUndefined();
    expect(sent.mails).toHaveLength(1);
    const rows = await sql`SELECT 1 FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    expect(rows).toHaveLength(0);
  });

  it("answers 409 for an address that already has an account", async () => {
    const email = freshEmail();
    await sql`INSERT INTO users (email, membership_tier) VALUES (${email}, 'base')`;
    expect((await post("/register", { email, password: "password1" })).status).toBe(409);
  });

  it("keeps the same browser on its code when it submits again inside the wait", async () => {
    const email = freshEmail();
    const first = await post("/register", { email, password: "password1" });
    const cookie = cookiePair(first, "breatic_signup_")!;
    const again = await post("/register", { email, password: "password1" }, cookie);

    expect(again.status).toBe(202);
    const body = (await again.json()) as { data: { resendAfterSeconds: number } };
    expect(body.data.resendAfterSeconds).toBeGreaterThan(0);
    expect(sent.mails).toHaveLength(1);
  });

  it("answers another browser inside the wait with 429 and Retry-After", async () => {
    const email = freshEmail();
    await post("/register", { email, password: "password1" });
    const res = await post("/register", { email, password: "password1" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("POST /auth/register/verify", () => {
  it("creates the account, signs it in, clears the ticket and reports no personal studio yet", async () => {
    const email = freshEmail();
    const started = await post("/register", { email, password: "password1" });
    const ticket = cookiePair(started, "breatic_signup_")!;
    const res = await post("/register/verify", { code: lastCode() }, ticket);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: { email: string; personalStudio: unknown } } };
    expect(body.data.user.email).toBe(email);
    expect(body.data.user).toHaveProperty("personalStudio", null);

    const session = cookiePair(res, sessionCookieName());
    expect(session).toBeDefined();
    expect(setCookies(res).find((c) => c.startsWith("breatic_signup_"))).toMatch(/Max-Age=0/);

    const me = await app.request("/api/v1/auth/me", { headers: { Cookie: session! } });
    expect(me.status).toBe(200);
  });

  it("answers 400 to a wrong code", async () => {
    const email = freshEmail();
    const started = await post("/register", { email, password: "password1" });
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    const res = await post("/register/verify", { code: wrong }, cookiePair(started, "breatic_signup_"));
    expect(res.status).toBe(400);
  });

  it("rejects a code that is not six digits before it touches the pending sign-up", async () => {
    const email = freshEmail();
    const started = await post("/register", { email, password: "password1" });
    const res = await post("/register/verify", { code: "12ab56" }, cookiePair(started, "breatic_signup_"));
    expect(res.status).toBe(400);
    // The malformed try did not use one of the code's five comparisons.
    for (let i = 0; i < 4; i++) {
      await post("/register/verify", { code: lastCode() === "000000" ? "111111" : "000000" }, cookiePair(started, "breatic_signup_"));
    }
    const res2 = await post("/register/verify", { code: lastCode() }, cookiePair(started, "breatic_signup_"));
    expect(res2.status).toBe(201);
  });

  it("answers 410 without a ticket", async () => {
    expect((await post("/register/verify", { code: "123456" })).status).toBe(410);
  });
});

describe("POST /auth/register/resend", () => {
  it("answers 429 with Retry-After inside the wait", async () => {
    const email = freshEmail();
    const started = await post("/register", { email, password: "password1" });
    const res = await post("/register/resend", {}, cookiePair(started, "breatic_signup_"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("answers 410 without a ticket", async () => {
    expect((await post("/register/resend", {})).status).toBe(410);
  });
});
