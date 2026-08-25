// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `GET /api/v1/account/membership` — the panel's one request (task #90).
 *
 * The service behind it is pinned in account-membership; this suite covers
 * what only the app can answer: the route is mounted, it is behind auth, it
 * answers about the caller rather than about anybody named in the request,
 * and it wraps the answer in the `{ data }` envelope every other route uses.
 *
 * The enterprise case is here rather than only at the service layer because
 * the failure it guards against is an HTTP one: reading that tier's ceilings
 * throws a plain `Error`, and `error-handler.ts` turns anything that is not
 * an `AppError` into a 500. A regression that reached for the ceilings before
 * checking the tier would leave those accounts with a panel that never loads,
 * and only a request through the real app shows that.
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
  getMembershipLimits,
} from "@breatic/core";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const ROUTE = "/api/v1/account/membership";

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "account-membership-route-test" },
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
 * @returns The account's id and its personal studio's id.
 * @throws {Error} if any insert fails.
 */
async function insertUser(
  tier: string,
): Promise<{ userId: string; personalStudioId: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`acct-route-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  const userId = rows[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`acct-route-p-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studios[0]!.id}, ${userId}, 'admin')
  `;
  return { userId, personalStudioId: studios[0]!.id };
}

/**
 * Stores one asset of a given size against a studio.
 * @param studioId - The studio the bytes are charged to.
 * @param sizeBytes - How many bytes to record.
 * @throws {Error} if the insert fails.
 */
async function insertAsset(studioId: string, sizeBytes: number): Promise<void> {
  await sql`
    INSERT INTO studio_assets
      (studio_id, produced_by_user_id, content_hash, storage_key,
       file_url, mime_type, kind, source, size_bytes)
    VALUES (
      ${studioId},
      (SELECT created_by_user_id FROM studios WHERE id = ${studioId}),
      ${`hash-${seq++}`},
      ${`key-${seq++}`},
      ${`https://example.test/${seq++}.png`},
      'image/png',
      'image',
      'upload',
      ${sizeBytes}
    )
  `;
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

describe("GET /api/v1/account/membership", () => {
  it("refuses an unauthenticated request", async () => {
    const res = await app.request(ROUTE);

    expect(res.status).toBe(401);
  });

  it("answers about the caller, in the standard envelope", async () => {
    const { userId, personalStudioId } = await insertUser("pro");
    await insertAsset(personalStudioId, 4096);

    const res = await app.request(ROUTE, {
      headers: { Cookie: await loginCookie(userId) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        tier: string;
        limits: Record<string, number>;
        usage: { teamStudios: number; storageBytes: number };
        catalog: { tier: string }[];
      };
    };
    expect(body.data.tier).toBe("pro");
    expect(body.data.limits).toEqual(getMembershipLimits("pro"));
    expect(body.data.usage).toEqual({ teamStudios: 0, storageBytes: 4096 });
    expect(body.data.catalog.map((entry) => entry.tier)).toEqual([
      "base",
      "pro",
      "team",
    ]);
  });

  it("answers an enterprise account with 200 and a null `limits`", async () => {
    // Not a 500: that tier's ceilings are negotiated and reading them throws
    // by design (#105). The account is legal, so its panel has to load.
    const { userId } = await insertUser("enterprise");

    const res = await app.request(ROUTE, {
      headers: { Cookie: await loginCookie(userId) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tier: string; limits: unknown };
    };
    expect(body.data.tier).toBe("enterprise");
    expect(body.data.limits).toBeNull();
  });

  it("describes the caller, not another account whose id is sent along", async () => {
    // The account is taken from the session. Nothing in the request names it,
    // so there is no id to swap — this pins that no future revision adds one.
    const caller = await insertUser("base");
    const other = await insertUser("team");

    const res = await app.request(`${ROUTE}?userId=${other.userId}`, {
      headers: { Cookie: await loginCookie(caller.userId) },
    });

    const body = (await res.json()) as { data: { tier: string } };
    expect(body.data.tier).toBe("base");
  });
});
