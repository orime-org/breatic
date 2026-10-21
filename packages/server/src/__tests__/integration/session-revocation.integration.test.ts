// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ending sessions announces them to collab (inner#1548) — real PG + Redis.
 *
 * Collab reads a session once, at the handshake, so deleting the key alone
 * leaves every document the session already opened writable. Every way a
 * session ends deletes its key and publishes its id on the revocation channel
 * in the same call; collab closes the matching connections.
 *
 * The pins:
 *
 *   1. One session ends: its key goes, its id is published, nobody else's key
 *      is touched; an already-gone session publishes nothing.
 *   2. All of a person's sessions end, optionally keeping one: exactly the
 *      deleted ids are published, the kept one and other people's stay.
 *   3. A failed publish still deletes and reports the failure to the caller.
 *   4. `POST /auth/logout-others` keeps the caller's session and ends the rest;
 *      it needs a session and is rate limited per account and per address.
 *   5. Sign out and both password resets publish what they delete.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

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
  getStreamRedis,
  getSession,
  setSession,
  sessionCookieName,
  sessionId,
  revokeSession,
  revokeAllSessions,
  sessionsRevokedChannelName,
  loadLocales,
  env,
  type Redis,
} from "@breatic/core";
import type { SessionsRevokedEvent } from "@breatic/shared";
import { hashRecoveryCode } from "@server/modules/auth/recovery-code.service.js";
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
let createApp: () => Hono;
let subscriber: Redis;
let heard: SessionsRevokedEvent[] = [];
let seq = 0;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "session-revocation-test" },
  });
  ({ createApp } = await import("@server/app.js"));
  app = withPeer(createApp());
  subscriber = getStreamRedis().duplicate();
  subscriber.on("message", (_channel: string, message: string) => {
    heard.push(JSON.parse(message) as SessionsRevokedEvent);
  });
  await subscriber.subscribe(sessionsRevokedChannelName());
});

afterEach(() => {
  heard = [];
  vi.restoreAllMocks();
});

afterAll(async () => {
  await subscriber?.quit();
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account with a personal studio.
 * @returns Its id and email.
 * @throws {Error} if an insert fails.
 */
async function account(): Promise<{ userId: string; email: string }> {
  const email = `revoke-${Date.now()}-${seq++}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  const userId = row!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`revoke-p-${Date.now()}-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  return { userId, email };
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
 * The Cookie header carrying a session.
 * @param token - The session token.
 * @returns The header value.
 */
function cookie(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

/**
 * Wait until the subscriber has heard a given number of announcements.
 * @param count - How many to wait for.
 * @returns What was heard.
 * @throws {Error} when they do not arrive within two seconds.
 */
async function hear(count: number): Promise<SessionsRevokedEvent[]> {
  const deadline = Date.now() + 2000;
  while (heard.length < count) {
    if (Date.now() > deadline) throw new Error(`heard ${heard.length} of ${count} announcements`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return heard;
}

/**
 * Give a publish that should not happen time to arrive.
 * @returns After 150 ms.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

describe("revokeSession", () => {
  it("deletes the one key and publishes its id", async () => {
    const { userId } = await account();
    const [ended, other] = [await session(userId), await session(userId)];

    const outcome = await revokeSession(getRedis(), ended);

    expect(outcome.signalFailure).toBeUndefined();
    expect(await getSession(getRedis(), ended)).toBeNull();
    expect(await getSession(getRedis(), other)).toBe(userId);
    const [event] = await hear(1);
    expect(event).toMatchObject({ type: "sessions:revoked", userId, sessionIds: [sessionId(ended)] });
  });

  it("publishes nothing for a session that is already gone", async () => {
    await revokeSession(getRedis(), crypto.randomBytes(24).toString("hex"));
    await settle();
    expect(heard).toEqual([]);
  });

  it("never puts the token itself on the channel", async () => {
    const { userId } = await account();
    const token = await session(userId);
    await revokeSession(getRedis(), token);
    const [event] = await hear(1);
    expect(JSON.stringify(event)).not.toContain(token);
    expect(sessionId(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still deletes when the publish fails, and says so", async () => {
    const { userId } = await account();
    const token = await session(userId);
    const failure = new Error("publish refused");
    vi.spyOn(getStreamRedis(), "publish").mockRejectedValueOnce(failure);

    const outcome = await revokeSession(getRedis(), token);

    expect(outcome.signalFailure).toBe(failure);
    expect(await getSession(getRedis(), token)).toBeNull();
  });
});

describe("revokeAllSessions", () => {
  it("deletes every session of the person and publishes exactly those ids", async () => {
    const { userId } = await account();
    const { userId: someoneElse } = await account();
    const mine = [await session(userId), await session(userId)];
    const theirs = await session(someoneElse);

    await revokeAllSessions(getRedis(), userId);

    for (const token of mine) expect(await getSession(getRedis(), token)).toBeNull();
    expect(await getSession(getRedis(), theirs)).toBe(someoneElse);
    const [event] = await hear(1);
    expect(event!.userId).toBe(userId);
    expect([...event!.sessionIds].sort()).toEqual(mine.map(sessionId).sort());
  });

  it("keeps the one it is told to keep", async () => {
    const { userId } = await account();
    const kept = await session(userId);
    const ended = [await session(userId), await session(userId)];

    await revokeAllSessions(getRedis(), userId, { keep: kept });

    expect(await getSession(getRedis(), kept)).toBe(userId);
    for (const token of ended) expect(await getSession(getRedis(), token)).toBeNull();
    const [event] = await hear(1);
    expect([...event!.sessionIds].sort()).toEqual(ended.map(sessionId).sort());
  });

  it("publishes nothing when there was nothing to end", async () => {
    const { userId } = await account();
    const kept = await session(userId);
    await revokeAllSessions(getRedis(), userId, { keep: kept });
    await settle();
    expect(heard).toEqual([]);
  });
});

describe("POST /auth/logout-others", () => {
  it("keeps the caller's session and ends the others", async () => {
    const { userId } = await account();
    const current = await session(userId);
    const others = [await session(userId), await session(userId)];

    const res = await app.request("/api/v1/auth/logout-others", {
      method: "POST",
      headers: { Cookie: cookie(current) },
    });

    expect(res.status).toBe(200);
    expect(await getSession(getRedis(), current)).toBe(userId);
    for (const token of others) expect(await getSession(getRedis(), token)).toBeNull();
    const [event] = await hear(1);
    expect([...event!.sessionIds].sort()).toEqual(others.map(sessionId).sort());
  });

  it("answers 401 without a session", async () => {
    const res = await app.request("/api/v1/auth/logout-others", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("is limited per account", async () => {
    const { userId } = await account();
    const current = await session(userId);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await app.request("/api/v1/auth/logout-others", {
        method: "POST",
        headers: { Cookie: cookie(current) },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("is limited per address across accounts", async () => {
    // Each call scans every session key, so many accounts behind one address
    // must not multiply the scans.
    const hex = (): string => crypto.randomBytes(2).toString("hex");
    const ip = `2001:db8:${hex()}:${hex()}::1`;
    const statuses: number[] = [];
    for (let n = 0; n < 4; n += 1) {
      const { userId } = await account();
      const current = await session(userId);
      for (let i = 0; i < (n < 3 ? 10 : 1); i += 1) {
        const res = await createApp().request(
          "/api/v1/auth/logout-others",
          { method: "POST", headers: { Cookie: cookie(current), "x-real-ip": ip } },
          PROXY_PEER,
        );
        statuses.push(res.status);
      }
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("the other ways a session ends", () => {
  it("signing out publishes the one session", async () => {
    const { userId } = await account();
    const token = await session(userId);
    const res = await app.request("/api/v1/auth/logout", { method: "POST", headers: { Cookie: cookie(token) } });
    expect(res.status).toBe(200);
    const [event] = await hear(1);
    expect(event!.sessionIds).toEqual([sessionId(token)]);
  });

  it("an email reset publishes every session of the person", async () => {
    const { userId } = await account();
    const tokens = [await session(userId), await session(userId)];
    const resetToken = crypto.randomBytes(16).toString("hex");
    await getRedis().set(`${env.ENV}:password-reset:${resetToken}`, userId, "EX", 600);

    const res = await app.request("/api/v1/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: resetToken, password: "a-new-password-1" }),
    });

    expect(res.status).toBe(200);
    const [event] = await hear(1);
    expect([...event!.sessionIds].sort()).toEqual(tokens.map(sessionId).sort());
  });

  it("a recovery-code reset publishes every session of the person", async () => {
    const { userId, email } = await account();
    const tokens = [await session(userId), await session(userId)];
    const code = "RECOVERY-CODE-1548";
    await sql`UPDATE users SET recovery_code_hash = ${await hashRecoveryCode(code)} WHERE id = ${userId}`;

    const res = await app.request("/api/v1/auth/reset-password-with-recovery-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, recoveryCode: code, newPassword: "a-new-password-1" }),
    });

    expect(res.status).toBe(200);
    const [event] = await hear(1);
    expect([...event!.sessionIds].sort()).toEqual(tokens.map(sessionId).sort());
  });
});
