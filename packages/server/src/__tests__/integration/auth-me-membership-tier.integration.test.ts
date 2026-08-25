// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The session payload carries the account's tier (task #90) — real PG + Redis.
 *
 * The avatar menu shows which tier the account is on, and it renders in every
 * studio's top bar. Reading that from the membership endpoint would mean
 * summing the assets of every studio the account controls just to light up a
 * label, so the tier travels with the session payload instead — it is a fixed
 * property of the account, the same kind of thing as its email.
 *
 * The pins:
 *
 *   1. `/auth/me` reports the tier stored on the account, whichever it is.
 *   2. It reports the stored value rather than a default, so an account that
 *      was moved to another tier is described correctly on the next load.
 *   3. `enterprise` comes back like any other tier. Reading that tier's
 *      ceilings throws by design (#105); the name is not the ceilings, and
 *      nothing on this path should confuse the two.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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
let seq = 0;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "auth-me-tier-test" },
  });
  // Imported after initCore ran: `@server/app.js` pulls cors.ts, which reads
  // `env.ALLOWED_ORIGINS` while the module evaluates.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Creates a verified account on a given tier, with its personal studio.
 * @param tier - The tier to store on the account row.
 * @returns The account's id.
 * @throws {Error} if any insert fails.
 */
async function insertUser(tier: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`auth-tier-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  const userId = rows[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`auth-tier-p-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studios[0]!.id}, ${userId}, 'admin')
  `;
  return userId;
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

describe("GET /auth/me — membership tier in the session payload", () => {
  it("reports the tier stored on the account", async () => {
    const userId = await insertUser("pro");

    const res = await app.request("/api/v1/auth/me", {
      headers: { Cookie: await loginCookie(userId) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { membershipTier: string } };
    expect(body.data.membershipTier).toBe("pro");
  });

  it("reports a moved account's current tier, not the registration default", async () => {
    // #105 lets an account be moved between tiers. A payload that answered
    // from the default would describe the account it used to be.
    const userId = await insertUser("base");
    await sql`UPDATE users SET membership_tier = 'team' WHERE id = ${userId}`;

    const res = await app.request("/api/v1/auth/me", {
      headers: { Cookie: await loginCookie(userId) },
    });

    const body = (await res.json()) as { data: { membershipTier: string } };
    expect(body.data.membershipTier).toBe("team");
  });

  it("reports enterprise like any other tier", async () => {
    // The panel needs ceilings, which enterprise has none of; the menu needs
    // only the name, which every tier has. Nothing here should reach the
    // ceilings lookup that throws for this tier.
    const userId = await insertUser("enterprise");

    const res = await app.request("/api/v1/auth/me", {
      headers: { Cookie: await loginCookie(userId) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { membershipTier: string } };
    expect(body.data.membershipTier).toBe("enterprise");
  });
});
