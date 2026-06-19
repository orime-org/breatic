// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * "Recent" landing ROUTE contract — `POST /projects/:id/opened` +
 * `GET /studios/recent`, driven end-to-end through the real Hono app against a
 * real Postgres + Redis.
 *
 * The service-layer data + access invariants (upsert, ordering, the
 * never-leak-inaccessible-project filter) are pinned in
 * `recently-opened.integration.test.ts`. THIS suite verifies the HTTP contract
 * those cannot: the auth boundary (`requireAuth` → 401 for the unauthenticated),
 * that recording an open is access-gated to a `404` (hiding existence), and
 * that the feed returned over the wire is correctly access-filtered. Design doc
 * §4, acceptance C2 + C3 (HTTP contract test + real-PG integration).
 *
 * Auth is real: each caller gets a Redis session token (the same store
 * `requireAuth` reads), passed as the `breatic_session` cookie. Seeding uses a
 * narrow raw `postgres` client; assertions go through the real `createApp()`.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core / the app (the core + domain barrels
// pull agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build Node's
// native ESM rejects). This suite never calls any ai function.
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
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const PG_DRIVER_LOCAL = "recent-routes-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  // Import the app AFTER initCore ran (app.js → cors.ts reads env at module
  // load; the dynamic import defers it past initCore above).
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a fresh registered user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `rr-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let studioSeq = 0;
/** Insert a fresh team studio; returns its id. */
async function insertStudio(createdByUserId: string): Promise<string> {
  const slug = `rr-studio-${studioSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${slug}, 'team', ${`Studio ${slug}`})
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Seed a studio_members row. */
async function insertStudioMember(
  studioId: string,
  userId: string,
  role: "admin" | "maintainer" | "guest",
): Promise<void> {
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, ${role})
  `;
}

let projSeq = 0;
/** Insert a fresh project (+ owner row); returns the project id. */
async function insertProject(
  studioId: string,
  ownerUserId: string,
  visibility: "studio" | "private",
): Promise<string> {
  const slug = `rr-project-${projSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${ownerUserId}, ${`Project ${slug}`}, ${slug}, ${visibility})
    RETURNING id
  `;
  const projectId = rows[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerUserId}, 'owner', null)
  `;
  return projectId;
}

/** Count active project_last_opened rows for a user+project. */
async function openRowCount(userId: string, projectId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM project_last_opened
    WHERE user_id = ${userId} AND project_id = ${projectId}
  `;
  return rows[0]!.n;
}

/** Mint a real Redis session and return the authenticating Cookie header. */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `breatic_session=${token}`;
}

describe("POST /api/v1/projects/:id/opened — record open (real PG + Redis)", () => {
  it("200 for an authorized member; the open is recorded", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner, "studio");

    const res = await app.request(`/api/v1/projects/${pid}/opened`, {
      method: "POST",
      headers: { Cookie: await loginCookie(owner) },
    });

    expect(res.status).toBe(200);
    expect(await openRowCount(owner, pid)).toBe(1);
  });

  it("404 when the caller cannot access the project (existence hidden, no row)", async () => {
    const owner = await insertUser();
    const stranger = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner, "private");

    const res = await app.request(`/api/v1/projects/${pid}/opened`, {
      method: "POST",
      headers: { Cookie: await loginCookie(stranger) },
    });

    expect(res.status).toBe(404);
    expect(await openRowCount(stranger, pid)).toBe(0);
  });

  it("401 for the unauthenticated (no session cookie)", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner, "studio");

    const res = await app.request(`/api/v1/projects/${pid}/opened`, {
      method: "POST",
    });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/studios/recent — landing feed (real PG + Redis)", () => {
  it("returns the user's accessible recent projects, excluding inaccessible ones", async () => {
    const owner = await insertUser();
    const user = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, user, "guest");

    // The user opens a studio-visible project through the real endpoint.
    const pVisible = await insertProject(studioId, owner, "studio");
    // A studio-visible open-baseline project materializes a viewer row on read;
    // here the user already qualifies via studio membership, so POST opened is
    // access-gated through to a 200 (assertAccess admits the materialized/owner
    // path). Seed a viewer row so the access gate passes deterministically.
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${pVisible}, ${user}, 'viewer', null)
    `;
    const cookie = await loginCookie(user);
    const openRes = await app.request(`/api/v1/projects/${pVisible}/opened`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(openRes.status).toBe(200);

    // The user ALSO has a stale open row for someone else's private project
    // they can no longer access — it must NOT come back over the wire.
    const pOthersPrivate = await insertProject(studioId, owner, "private");
    await sql`
      INSERT INTO project_last_opened (user_id, project_id, last_opened_at)
      VALUES (${user}, ${pOthersPrivate}, now())
    `;

    const res = await app.request(`/api/v1/studios/recent`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ projectId: string }> };
    const ids = new Set(body.data.map((r) => r.projectId));
    expect(ids.has(pVisible)).toBe(true);
    expect(ids.has(pOthersPrivate)).toBe(false);
  });

  it("401 for the unauthenticated (no session cookie)", async () => {
    const res = await app.request(`/api/v1/studios/recent`);
    expect(res.status).toBe(401);
  });
});
