// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's language (`users.locale`, #286) — real PG + Redis.
 *
 * Every email is rendered in the recipient's language, so the language has to
 * live on the account row where a sender can read it. It is written at sign-up
 * from the language the request was negotiated in, and changed only by the
 * user switching the interface language.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  runWithLocale,
} from "@breatic/core";
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
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "user-locale-test" },
  });
  // Imported after initCore ran: `@server/app.js` pulls cors.ts, which reads
  // `env.ALLOWED_ORIGINS` while the module evaluates.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${id}`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Inserts an account without naming a language, the way every row before
 * this column existed was written.
 * @returns The account's id.
 * @throws {Error} if the insert fails.
 */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`user-locale-${crypto.randomUUID()}@example.test`}, true, 'base')
    RETURNING id
  `;
  created.push(rows[0]!.id);
  return rows[0]!.id;
}

/**
 * Mints a real Redis session and returns the Cookie header for it.
 * @param userId - The account to authenticate as.
 * @returns A `Cookie` header value `requireAuth` accepts.
 * @throws {Error} if Redis is unreachable.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Reads the stored language of an account.
 * @param userId - The account.
 * @returns The `locale` column value.
 * @throws {Error} if the row is missing.
 */
async function storedLocale(userId: string): Promise<string> {
  const rows = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE id = ${userId}`;
  return rows[0]!.locale;
}

/**
 * Sends `PATCH /users/me/locale` as the given account.
 * @param userId - The account.
 * @param locale - The value to send.
 * @returns The response.
 */
async function patchLocale(userId: string, locale: unknown): Promise<Response> {
  return app.request("/api/v1/users/me/locale", {
    method: "PATCH",
    headers: { Cookie: await loginCookie(userId), "Content-Type": "application/json" },
    body: JSON.stringify({ locale }),
  });
}

describe("users.locale", () => {
  it("defaults to en for a row written without a language", async () => {
    const userId = await insertUser();
    expect(await storedLocale(userId)).toBe("en");
  });

  it("stores the negotiated language on email sign-up", async () => {
    const email = `user-locale-reg-${crypto.randomUUID()}@example.test`;
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "zh-CN" },
      body: JSON.stringify({ email, password: "password1234" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: { id: string; locale: string } } };
    created.push(body.data.user.id);
    expect(body.data.user.locale).toBe("zh-CN");
    expect(await storedLocale(body.data.user.id)).toBe("zh-CN");
  });

  it("stores the negotiated language when Google creates the account", async () => {
    const { authService } = await import("@server/modules");
    const email = `user-locale-google-${crypto.randomUUID()}@example.test`;
    const { user } = await runWithLocale("ja", () =>
      authService.loginOrCreateGoogle(crypto.randomUUID(), email),
    );
    created.push(user.id);
    expect(user.locale).toBe("ja");
    expect(await storedLocale(user.id)).toBe("ja");
  });

  it("reports the stored language from /auth/me", async () => {
    const userId = await insertUser();
    await sql`UPDATE users SET locale = 'ko' WHERE id = ${userId}`;

    const res = await app.request("/api/v1/auth/me", {
      headers: { Cookie: await loginCookie(userId), "Accept-Language": "en" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { locale: string } };
    expect(body.data.locale).toBe("ko");
  });

  it("changes the stored language through PATCH /users/me/locale", async () => {
    const userId = await insertUser();

    const res = await patchLocale(userId, "zh-TW");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { locale: string } };
    expect(body.data.locale).toBe("zh-TW");
    expect(await storedLocale(userId)).toBe("zh-TW");
  });

  it("rejects a language the product does not ship and leaves the column alone", async () => {
    const userId = await insertUser();
    await sql`UPDATE users SET locale = 'ja' WHERE id = ${userId}`;

    for (const bad of ["fr", "zh", "", 5, null]) {
      const res = await patchLocale(userId, bad);
      expect(res.status, `locale ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(await storedLocale(userId)).toBe("ja");
  });

  it("refuses PATCH without a session", async () => {
    const res = await app.request("/api/v1/users/me/locale", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "ja" }),
    });
    expect(res.status).toBe(401);
  });
});
