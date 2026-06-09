// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Team studio creation ROUTE invariants — `POST /api/v1/studios` (create) +
 * `GET /api/v1/studios/slug-available` (live check), driven end-to-end through
 * the real Hono app against a real Postgres + Redis.
 *
 * The service-layer data invariants (atomic team+admin, slug-unique 409, the
 * per-user limit) are pinned in team-studio-create. THIS suite verifies the
 * HTTP boundary those cannot: auth gate (real `requireAuth`), body validation
 * (`zValidator`), the JSON envelope + status codes, and the slug-check endpoint.
 *
 *   - POST /studios authenticated      → 201, creator is the studio admin
 *   - POST /studios NO session         → the real requireAuth status (pinned)
 *   - POST /studios malformed slug     → the real zValidator status (pinned)
 *   - POST /studios taken slug         → 409
 *   - GET  /slug-available fresh/taken → { available } envelope
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

import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, getRedis, setSession, loadLocales } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "team-studio-create-routes-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/** Insert a fresh registered user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `tscr-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let slugSeq = 0;
/** A unique, well-formed studio slug (lowercase, 6–39 chars). */
function uniqueSlug(): string {
  return `tscr-${(slugSeq++).toString().padStart(6, "0")}`;
}

/** Mint a real Redis session and return the authenticating Cookie header. */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `breatic_session=${token}`;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

describe("team studio create routes (real PG + Redis)", () => {
  it("POST /api/v1/studios → 201 creates a team studio with the caller as admin", async () => {
    const user = await insertUser();
    const res = await app.request("/api/v1/studios", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(user) },
      body: JSON.stringify({ name: "My Team", slug: uniqueSlug() }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; type: string } };
    expect(body.data.type).toBe("team");
    expect(await studioMembersRepo.getRole(body.data.id, user)).toBe("admin");
  });

  it("POST /api/v1/studios → 401 for an unauthenticated request (real requireAuth)", async () => {
    const res = await app.request("/api/v1/studios", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "X", slug: uniqueSlug() }),
    });
    // Pins the real requireAuth status for a protected write route (corrects
    // the stale "all protected routes 404" memory — requireAuth returns 401).
    expect(res.status).toBe(401);
  });

  it("POST /api/v1/studios → 400 for a malformed slug (real zValidator)", async () => {
    const user = await insertUser();
    const res = await app.request("/api/v1/studios", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(user) },
      body: JSON.stringify({ name: "X", slug: "Bad Slug!" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/v1/studios → 409 for a taken slug", async () => {
    const u1 = await insertUser();
    const u2 = await insertUser();
    const slug = uniqueSlug();
    await app.request("/api/v1/studios", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(u1) },
      body: JSON.stringify({ name: "First", slug }),
    });
    const res = await app.request("/api/v1/studios", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(u2) },
      body: JSON.stringify({ name: "Second", slug }),
    });
    expect(res.status).toBe(409);
  });

  it("GET /api/v1/studios/slug-available → available for fresh, taken for existing", async () => {
    const user = await insertUser();
    const fresh = uniqueSlug();
    const r1 = await app.request(`/api/v1/studios/slug-available?slug=${fresh}`, {
      headers: { Cookie: await loginCookie(user) },
    });
    expect(r1.status).toBe(200);
    expect((await r1.json()).data).toEqual({ available: true });

    const taken = uniqueSlug();
    await app.request("/api/v1/studios", {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(user) },
      body: JSON.stringify({ name: "Taken", slug: taken }),
    });
    const r2 = await app.request(`/api/v1/studios/slug-available?slug=${taken}`, {
      headers: { Cookie: await loginCookie(user) },
    });
    expect((await r2.json()).data).toEqual({ available: false, reason: "taken" });
  });

  it("GET /api/v1/studios/slug-available → 401 unauthenticated", async () => {
    const res = await app.request(`/api/v1/studios/slug-available?slug=${uniqueSlug()}`);
    expect(res.status).toBe(401);
  });
});
