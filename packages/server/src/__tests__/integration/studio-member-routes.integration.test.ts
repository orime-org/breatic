// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio member-management ROUTE auth-gate invariants (slice 3) — the
 * `requireStudioRole('admin')` middleware in front of the three member-write
 * routes, driven end-to-end through the real Hono app against a real Postgres
 * + Redis.
 *
 * The service-layer data invariants (personal studio, sole admin,
 * already-member, revive-on-reinvite) are pinned in
 * studio-member-service / studio-members-write. THIS suite verifies the thing
 * those cannot: the HTTP authorization boundary. Membership writes touch
 * shared studio credits, so every route requires the studio `admin`; anyone
 * below must be denied with a generic 403 (which also hides studio existence
 * from non-members). That gate is `requireStudioRole`, which resolves the
 * studio by `:slug`, loads the caller's role (real SQL), and rejects — none of
 * which a mocked auth stub would exercise.
 *
 *   - POST   /studio/:slug/members          (invite)
 *   - DELETE /studio/:slug/members/:userId  (remove)
 *   - PATCH  /studio/:slug/members/:userId  (change role)
 *
 * Cases (all real PG testcontainer + real Redis session):
 *   1. non-member        POST   → 403 (gate denies, existence hidden)
 *   2. member (non-admin) POST  → 403 (below the admin floor)
 *   3. admin             POST   → 201, and the invitee is an active member
 *   4. admin             DELETE → 200, and the target is no longer a member
 *   5. admin             PATCH {role:"creator"} → 200, role flipped
 *
 * Auth is real: each caller gets a Redis session token (the same store
 * `requireAuth` reads), passed as the `breatic_session` cookie. Seeding uses a
 * narrow raw `postgres` client; the assertions go through the real Hono app
 * (`createApp`) and verify the studio side-effects via the real repo.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core / the app (the core + domain
// barrels pull agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build
// Node's native ESM rejects). This suite never calls any ai function; the
// stubs keep that broken ESM chain from loading at import time — the same
// guard every other studio integration suite uses.
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

// integration-setup.ts injects the container URLs into process.env but cannot
// call initCore itself (importing the core barrel pulls the `ai` SDK → otel).
// Inject the validated config so every env-bound singleton (db / Redis) the
// app touches resolves to the testcontainers. Guarded because the worker
// process is shared (singleFork) with sibling suites that may have inited.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
// Register locales so error responses carry real messages (loaded from the
// repo-root locales/ dir); harmless if the dir is absent under the runner.
loadLocales();

const PG_DRIVER_LOCAL = "studio-member-routes-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  // Import the app AFTER initCore ran: `@server/app.js` pulls cors.ts, which
  // reads `env.ALLOWED_ORIGINS` at module-load time — a static top-level import
  // would evaluate that before the initCore() above. The dynamic import defers
  // app module evaluation until the env is bound.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a fresh registered user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `smr-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/** Insert a fresh user and return both its id and email (invite needs email). */
async function insertUserWithEmail(): Promise<{ id: string; email: string }> {
  const email = `smr-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return { id: rows[0]!.id, email };
}

let studioSeq = 0;
/** Insert a fresh team studio created by the given user; returns id + slug. */
async function insertTeamStudio(createdByUserId: string): Promise<{ id: string; slug: string }> {
  const slug = `smr-studio-${studioSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${slug}, 'team', 'Route Test Team Studio')
    RETURNING id
  `;
  return { id: rows[0]!.id, slug };
}

/** Seed a studio_members row directly (bypasses the repo). */
async function insertMemberRaw(
  studioId: string,
  userId: string,
  role: "admin" | "creator" | "member",
): Promise<void> {
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, ${role})
  `;
}

/**
 * Mint a real Redis session for the user (the exact store `requireAuth`
 * reads) and return the `Cookie` header that authenticates them.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `breatic_session=${token}`;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

describe("studio member routes — requireStudioRole('admin') gate (real PG + Redis)", () => {
  it("POST /studio/:slug/members → 403 for a NON-MEMBER (gate denies, existence hidden)", async () => {
    const admin = await insertUser();
    const studio = await insertTeamStudio(admin);
    await insertMemberRaw(studio.id, admin, "admin");
    const stranger = await insertUser();
    const invitee = await insertUserWithEmail();

    const res = await app.request(`/api/v1/studio/${studio.slug}/members`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(stranger) },
      body: JSON.stringify({ email: invitee.email, role: "member" }),
    });

    expect(res.status).toBe(403);
    // Gate denied before the service ran — no membership written.
    expect(await studioMembersRepo.getRole(studio.id, invitee.id)).toBeNull();
  });

  it("POST /studio/:slug/members → 403 for a non-admin MEMBER (below the admin floor)", async () => {
    const admin = await insertUser();
    const studio = await insertTeamStudio(admin);
    await insertMemberRaw(studio.id, admin, "admin");
    const member = await insertUser();
    await insertMemberRaw(studio.id, member, "member");
    const invitee = await insertUserWithEmail();

    const res = await app.request(`/api/v1/studio/${studio.slug}/members`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(member) },
      body: JSON.stringify({ email: invitee.email, role: "member" }),
    });

    expect(res.status).toBe(403);
    expect(await studioMembersRepo.getRole(studio.id, invitee.id)).toBeNull();
  });

  it("POST /studio/:slug/members → 201 for the ADMIN, and the invitee lands as an active member", async () => {
    const admin = await insertUser();
    const studio = await insertTeamStudio(admin);
    await insertMemberRaw(studio.id, admin, "admin");
    const invitee = await insertUserWithEmail();

    const res = await app.request(`/api/v1/studio/${studio.slug}/members`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(admin) },
      body: JSON.stringify({ email: invitee.email, role: "member" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);
    expect(await studioMembersRepo.getRole(studio.id, invitee.id)).toBe("member");
  });

  it("DELETE /studio/:slug/members/:userId → 200 for the ADMIN, and the target is removed", async () => {
    const admin = await insertUser();
    const studio = await insertTeamStudio(admin);
    await insertMemberRaw(studio.id, admin, "admin");
    const member = await insertUser();
    await insertMemberRaw(studio.id, member, "member");
    expect(await studioMembersRepo.getRole(studio.id, member)).toBe("member");

    const res = await app.request(`/api/v1/studio/${studio.slug}/members/${member}`, {
      method: "DELETE",
      headers: { Cookie: await loginCookie(admin) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);
    expect(await studioMembersRepo.getRole(studio.id, member)).toBeNull();
  });

  it("PATCH /studio/:slug/members/:userId {role:'creator'} → 200 for the ADMIN, and the role flips", async () => {
    const admin = await insertUser();
    const studio = await insertTeamStudio(admin);
    await insertMemberRaw(studio.id, admin, "admin");
    const member = await insertUser();
    await insertMemberRaw(studio.id, member, "member");

    const res = await app.request(`/api/v1/studio/${studio.slug}/members/${member}`, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, Cookie: await loginCookie(admin) },
      body: JSON.stringify({ role: "creator" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);
    expect(await studioMembersRepo.getRole(studio.id, member)).toBe("creator");
  });
});
