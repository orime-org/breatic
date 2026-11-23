// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Desktop sign-in handoff (#1599) — real PG + Redis.
 *
 * The desktop client opens `/desktop/sign-in?challenge=…` in the system
 * browser. The browser, signed in, asks `POST /auth/desktop-handoff` for a
 * one-time code bound to the challenge; the client page trades code and the
 * verifier behind the challenge at `POST /auth/desktop-exchange` for its own
 * session (RFC 7636 style).
 *
 * The pins:
 *
 *   1. A handoff needs a session and a well-formed challenge.
 *   2. Code plus the matching verifier opens a new session for the account
 *      that handed off, answered in the same shape as `POST /auth/google`.
 *   3. A code works once; a wrong verifier burns it; an expired or unknown
 *      code, or a deleted account, gets 401 and a warning in the log.
 *   4. Redis holds a hash of the code, never the code.
 *   5. Invariant: no verifier other than the one behind the challenge ever
 *      opens a session (property-based).
 *   6. Both routes are rate limited.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";
import type * as BreaticCore from "@breatic/core";

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

const logWarn = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", async (io) => {
  const actual = await io<typeof BreaticCore>();
  // `warn` is recorded as well as written, so a test can read why a request was refused.
  const logger = new Proxy(actual.logger, {
    get: (target, prop) => {
      if (prop !== "warn") return Reflect.get(target, prop);
      return (...args: unknown[]) => {
        logWarn(...args);
        return Reflect.apply(target.warn, target, args) as unknown;
      };
    },
  });
  return { ...actual, logger };
});

import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { initCore, getRedis, getSession, revokeAllSessions, revokeSession, setSession, sessionCookieName, loadLocales, env } from "@breatic/core";
import type { Hono } from "hono";
import { PROXY_PEER, withPeer } from "../helpers/peer.js";

try {
  initCore(process.env);
} catch {
  // Already initialised by another file in this fork.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "desktop-handoff-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp(), PROXY_PEER);
});

afterEach(() => {
  logWarn.mockClear();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account with a personal studio.
 * @returns Its id.
 * @throws {Error} if an insert fails.
 */
async function account(): Promise<string> {
  const email = `desktop-${Date.now()}-${seq++}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  const userId = row!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`desktop-p-${Date.now()}-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  return userId;
}

/**
 * Mint a real session for an account.
 * @param userId - The account.
 * @returns The session token.
 * @throws {Error} if Redis is unreachable.
 */
async function session(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return token;
}

/**
 * A verifier and the challenge derived from it, as the desktop client makes them.
 * @returns The pair.
 */
function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** A distinct client address per call, so one test's requests do not spend another's quota. */
function ip(): string {
  return `203.0.113.${(seq++ % 250) + 1}`;
}

/**
 * Ask for a handoff code as a signed-in browser.
 * @param token - The browser's session token.
 * @param challenge - The challenge from the desktop client.
 * @returns The response.
 */
function handoff(token: string | null, challenge: unknown): Promise<Response> {
  return Promise.resolve(app.request("/api/v1/auth/desktop-handoff", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": ip(),
      ...(token ? { Cookie: `${sessionCookieName()}=${token}` } : {}),
    },
    body: JSON.stringify({ challenge }),
  }));
}

/**
 * Trade a code and verifier for a session, as the desktop client page does.
 * @param code - The handoff code.
 * @param verifier - The verifier behind the challenge.
 * @param from - The client address.
 * @returns The response.
 */
function exchange(code: unknown, verifier: unknown, from: string = ip()): Promise<Response> {
  return Promise.resolve(app.request("/api/v1/auth/desktop-exchange", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": from },
    body: JSON.stringify({ code, verifier }),
  }));
}

/**
 * A code handed off for a fresh account.
 * @returns The account, its code and the verifier behind it.
 * @throws {Error} when the handoff is refused.
 */
async function handedOff(): Promise<{ userId: string; code: string; verifier: string; browser: string }> {
  const userId = await account();
  const { verifier, challenge } = pkce();
  const browser = await session(userId);
  const res = await handoff(browser, challenge);
  if (res.status !== 200) throw new Error(`handoff answered ${res.status}`);
  const body = (await res.json()) as { data: { code: string } };
  return { userId, code: body.data.code, verifier, browser };
}

/**
 * The session token a response set, if any.
 * @param res - The response.
 * @returns The token, or null.
 */
function setToken(res: Response): string | null {
  const header = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(header);
  return match ? decodeURIComponent(match[1]!) : null;
}

describe("POST /auth/desktop-handoff", () => {
  it("answers 401 without a session", async () => {
    const res = await handoff(null, pkce().challenge);
    expect(res.status).toBe(401);
  });

  it.each([
    ["too short", "abc"],
    ["not base64url", "!".repeat(43)],
    ["too long", "a".repeat(44)],
    ["not a string", 42],
  ])("answers 422 to a challenge that is %s", async (_label, challenge) => {
    const res = await handoff(await session(await account()), challenge);
    expect(res.status).toBe(422);
  });

  it("answers a code", async () => {
    const res = await handoff(await session(await account()), pkce().challenge);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { code: string } };
    expect(body.data.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("keeps a hash of the code in Redis, never the code", async () => {
    const { code } = await handedOff();
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    const prefix = `${env.REDIS_KEY_PREFIX}:server:desktop-handoff:`;
    expect(await getRedis().exists(`${prefix}${hash}`)).toBe(1);
    expect(await getRedis().exists(`${prefix}${code}`)).toBe(0);
    const ttl = await getRedis().ttl(`${prefix}${hash}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });
});

describe("POST /auth/desktop-exchange", () => {
  it("opens a session for the account that handed off, shaped like the Google sign-in answer", async () => {
    const { userId, code, verifier } = await handedOff();
    const res = await exchange(code, verifier);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { user: { id: string; personalStudio: unknown } } };
    expect(body.data.user.id).toBe(userId);
    expect(body.data.user.personalStudio).not.toBeNull();
    const token = setToken(res);
    expect(token).not.toBeNull();
    expect(await getSession(getRedis(), token!)).toBe(userId);
  });

  it("works once", async () => {
    const { code, verifier } = await handedOff();
    expect((await exchange(code, verifier)).status).toBe(200);
    const again = await exchange(code, verifier);
    expect(again.status).toBe(401);
    expect(setToken(again)).toBeNull();
  });

  it("burns the code on a wrong verifier", async () => {
    const { code, verifier } = await handedOff();
    expect((await exchange(code, pkce().verifier)).status).toBe(401);
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  it("refuses an unknown code and logs why", async () => {
    const res = await exchange(crypto.randomBytes(32).toString("base64url"), pkce().verifier);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toBe("");
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ reason: "unknown_code" }), "desktop_exchange_refused");
  });

  it("refuses an expired code", async () => {
    const { code, verifier } = await handedOff();
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    await getRedis().del(`${env.REDIS_KEY_PREFIX}:server:desktop-handoff:${hash}`);
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  it("refuses an account deleted after the handoff", async () => {
    const { userId, code, verifier } = await handedOff();
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`;
    const res = await exchange(code, verifier);
    expect(res.status).toBe(401);
    expect(setToken(res)).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ reason: "account_gone" }), "desktop_exchange_refused");
  });

  it.each([
    ["signs out of every device", (userId: string) => revokeAllSessions(getRedis(), userId)],
    ["signs out in that browser", (_userId: string, browser: string) => revokeSession(getRedis(), browser)],
  ])("refuses a code once the browser session that asked for it ends: the user %s", async (_label, end) => {
    const { userId, code, verifier, browser } = await handedOff();
    await end(userId, browser);
    const res = await exchange(code, verifier);
    expect(res.status).toBe(401);
    expect(setToken(res)).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ reason: "session_gone" }), "desktop_exchange_refused");
  });

  it("answers 422 to a body without code or verifier", async () => {
    const res = await exchange(undefined, undefined);
    expect(res.status).toBe(422);
  });

  it("never opens a session for a verifier other than the one behind the challenge", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 43, maxLength: 128 }), async (guess) => {
        const { code, verifier } = await handedOff();
        fc.pre(guess !== verifier);
        const res = await exchange(code, guess);
        expect(res.status).toBe(401);
        expect(setToken(res)).toBeNull();
      }),
      { numRuns: 25 },
    );
  });
});

describe("rate limits", () => {
  it("limits exchanges per client address", async () => {
    const from = "198.51.100.77";
    const answers: number[] = [];
    for (let i = 0; i < 40; i++) {
      answers.push((await exchange(crypto.randomBytes(32).toString("base64url"), pkce().verifier, from)).status);
    }
    expect(answers).toContain(429);
  });

  it("limits handoffs per account", async () => {
    const token = await session(await account());
    const answers: number[] = [];
    for (let i = 0; i < 40; i++) answers.push((await handoff(token, pkce().challenge)).status);
    expect(answers).toContain(429);
  });
});
