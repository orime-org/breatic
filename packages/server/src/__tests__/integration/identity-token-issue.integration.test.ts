// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global region issues the identity token (inner#1955) — real PG + Redis.
 *
 * Other regions know who the user is only from a sixty-second token the
 * global region signs from the session. `GET /auth/me` issues one with every
 * page load and `POST /auth/identity` renews it in the background; both write
 * it as a cookie on the parent domain. A deployment with no signing key is a
 * single region and issues nothing.
 *
 * The pins:
 *
 *   1. `/auth/me` and `/auth/identity` set `breatic_identity` with the
 *      parent domain, HttpOnly, Secure, SameSite=Lax and Max-Age 60, holding
 *      a token that verifies and names this user and this session.
 *   2. `/auth/identity` without a session is 401 and sets nothing.
 *   3. Issuing backfills the session id index of a session made before it.
 *   4. With no signing key, `/auth/me` sets no identity cookie.
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

import crypto, { generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import {
  env,
  getRedis,
  initCore,
  loadLocales,
  sessionCookieName,
  sessionId,
  setSession,
  verifyIdentityToken,
} from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";
import { hashPassword } from "@server/modules/auth/auth.service.js";

const keys = generateKeyPairSync("ed25519");
const PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const SIGNING_ENV = {
  IDENTITY_SIGNING_KEY: PRIVATE_KEY,
  IDENTITY_SIGNING_KEY_ID: "k1",
  IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: PUBLIC_KEY }),
  IDENTITY_COOKIE_DOMAIN: ".example.test",
};

loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  initCore({ ...process.env, ...SIGNING_ENV });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "identity-token-issue-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account with its personal studio.
 * @returns The account id.
 * @throws {Error} if an insert fails.
 */
async function account(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`identity-${Date.now()}-${seq++}@example.test`}, true)
    RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`identity-p-${Date.now()}-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  return user!.id;
}

/**
 * A real session for an account.
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
 * The `breatic_identity` Set-Cookie line of a response, if any.
 * @param res - The response.
 * @returns The line, or undefined.
 */
function identityCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith("breatic_identity="));
}

/**
 * Check one issued cookie line names this user and session.
 * @param line - The Set-Cookie line.
 * @param userId - The expected user.
 * @param sessionToken - The session it was issued from.
 */
function expectIssued(line: string | undefined, userId: string, sessionToken: string): void {
  expect(line).toBeDefined();
  const attributes = line!.split(";").map((part) => part.trim().toLowerCase());
  expect(attributes).toContain("domain=.example.test");
  expect(attributes).toContain("httponly");
  expect(attributes).toContain("secure");
  expect(attributes).toContain("samesite=lax");
  expect(attributes).toContain("max-age=60");
  const value = line!.split(";")[0]!.slice("breatic_identity=".length);
  const verdict = verifyIdentityToken(value, { k1: PUBLIC_KEY }, Math.floor(Date.now() / 1000));
  expect(verdict.ok).toBe(true);
  if (verdict.ok) {
    expect(verdict.claims.sub).toBe(userId);
    expect(verdict.claims.sid).toBe(sessionId(sessionToken));
  }
}

describe("identity token issue in the global region", () => {
  it("is written by GET /auth/me", async () => {
    const userId = await account();
    const token = await session(userId);

    const res = await app.request("/api/v1/auth/me", { headers: { Cookie: `${sessionCookieName()}=${token}` } });

    expect(res.status).toBe(200);
    expectIssued(identityCookie(res), userId, token);
  });

  it("is written by POST /auth/login for the session it opens", async () => {
    const userId = await account();
    const [user] = await sql<{ email: string }[]>`
      UPDATE users SET hashed_password = ${await hashPassword("Identity-Login-1!")} WHERE id = ${userId} RETURNING email
    `;

    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": "203.0.113.9" },
      body: JSON.stringify({ email: user!.email, password: "Identity-Login-1!" }),
    });

    expect(res.status).toBe(200);
    const sessionLine = res.headers.getSetCookie().find((line) => line.startsWith(`${sessionCookieName()}=`));
    const sessionToken = sessionLine!.split(";")[0]!.slice(`${sessionCookieName()}=`.length);
    expectIssued(identityCookie(res), userId, sessionToken);
  });

  it("is renewed by POST /auth/identity", async () => {
    const userId = await account();
    const token = await session(userId);

    const res = await app.request("/api/v1/auth/identity", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName()}=${token}` },
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expectIssued(identityCookie(res), userId, token);
  });

  it("is refused without a session", async () => {
    const res = await app.request("/api/v1/auth/identity", { method: "POST" });

    expect(res.status).toBe(401);
    expect(identityCookie(res)).toBeUndefined();
  });

  it("backfills the session id index of a session made before the index existed", async () => {
    const userId = await account();
    const token = crypto.randomBytes(24).toString("hex");
    await getRedis().set(`${env.ENV}:session:${token}`, userId, "EX", 3600);

    await app.request("/api/v1/auth/identity", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName()}=${token}` },
    });

    expect(await getRedis().get(`${env.ENV}:session-id:${sessionId(token)}`)).toBe(userId);
  });

  it("is not written by a deployment with no signing key", async () => {
    initCore(process.env);
    try {
      const userId = await account();
      const token = await session(userId);

      const res = await app.request("/api/v1/auth/me", { headers: { Cookie: `${sessionCookieName()}=${token}` } });

      expect(res.status).toBe(200);
      expect(identityCookie(res)).toBeUndefined();
    } finally {
      initCore({ ...process.env, ...SIGNING_ENV });
    }
  });
});
