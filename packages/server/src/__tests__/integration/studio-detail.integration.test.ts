// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio container shell critical-path invariants —
 * `studioService.getStudioDetail` + `studioService.listUserStudios`
 * against a real Postgres (slice 1).
 *
 * The studio shell is the public front door (鉴权 — a CLAUDE.md critical
 * path). Two guarantees are SQL-level and can only be verified against real
 * Postgres (a mocked query builder returns whatever the test stages,
 * regardless of the JOIN / soft-delete / grouped-count clauses):
 *
 *   1. getStudioDetail.myStudioRole — `admin` / `member` for active members,
 *      `null` for a non-member. Decision A: a non-member gets the shell
 *      (200 + guest), NOT a 403; a missing slug is a 404.
 *   2. memberCount — the grouped count over `studio_members` excludes
 *      soft-deleted members.
 *   3. listUserStudios — every active membership (personal + team), with
 *      the personal studio first; a soft-deleted membership drops the studio.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts.
 * Seeding uses a narrow raw `postgres` client; the assertions call the real
 * `studioService` (core's env-bound `db`, pointed at the same container via
 * the injected config) and the real `loadStudioRole` (domain).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing the studio service (→ @breatic/domain barrel
// pulls agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build
// Node's native ESM rejects). This suite never calls any ai function; the
// stubs keep that broken ESM chain from loading at import time.
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

import postgres from "postgres";
import { initCore, NotFoundError } from "@breatic/core";
import * as studioService from "@server/modules/studio/studio.service.js";

// integration-setup.ts injects the container URLs into process.env. Inject
// the validated config so the repo's env-bound `db` Proxy resolves to the
// testcontainer. Guarded because the worker process is shared (singleFork)
// with sibling suites that may have already inited.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "studio-detail-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = inject("DATABASE_URL");
  sql = postgres(url, {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

// Unique counters so each test seeds independent entities (no truncation).
let seq = 0;

/** Insert a fresh user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `sd-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return rows[0]!.id;
}

let slugSeq = 0;
/** Insert a fresh studio of the given type; returns its id + slug. */
async function insertStudio(
  createdByUserId: string,
  type: "personal" | "team",
): Promise<{ id: string; slug: string }> {
  const slug = `studio-${slugSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${slug}, ${type}, ${`Studio ${slug}`})
    RETURNING id
  `;
  return { id: rows[0]!.id, slug };
}

/** Seed a studio_members row directly (bypasses the repo). */
async function insertMemberRaw(
  studioId: string,
  userId: string,
  role: "admin" | "guest",
): Promise<void> {
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, ${role})
  `;
}

async function softDeleteMember(studioId: string, userId: string): Promise<void> {
  await sql`
    UPDATE studio_members SET deleted_at = now()
    WHERE studio_id = ${studioId} AND user_id = ${userId}
  `;
}

describe("getStudioDetail — public shell + viewer role (decision A)", () => {
  it("resolves admin / member for active members and null (guest) for a non-member, with memberCount", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudio(owner, "team");
    await insertMemberRaw(studio.id, owner, "admin");
    await insertMemberRaw(studio.id, member, "guest");

    const asAdmin = await studioService.getStudioDetail(studio.slug, owner);
    expect(asAdmin.myStudioRole).toBe("admin");
    expect(asAdmin.id).toBe(studio.id);
    expect(asAdmin.slug).toBe(studio.slug);
    expect(asAdmin.type).toBe("team");
    expect(asAdmin.memberCount).toBe(2);

    expect((await studioService.getStudioDetail(studio.slug, member)).myStudioRole).toBe(
      "guest",
    );
    // Non-member gets the shell (200 + guest), NOT a 403 — decision A.
    expect(
      (await studioService.getStudioDetail(studio.slug, stranger)).myStudioRole,
    ).toBeNull();
  });

  it("throws NotFoundError for a slug with no active studio", async () => {
    const user = await insertUser();
    await expect(
      studioService.getStudioDetail("no-such-studio-slug", user),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("excludes a soft-deleted member from memberCount and resolves their role to null", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(owner, "team");
    await insertMemberRaw(studio.id, owner, "admin");
    await insertMemberRaw(studio.id, member, "guest");
    expect((await studioService.getStudioDetail(studio.slug, owner)).memberCount).toBe(2);

    await softDeleteMember(studio.id, member);

    const after = await studioService.getStudioDetail(studio.slug, owner);
    expect(after.memberCount).toBe(1);
    expect((await studioService.getStudioDetail(studio.slug, member)).myStudioRole).toBeNull();
  });
});

describe("listUserStudios — switcher list, personal-first", () => {
  it("returns every active membership (personal + team) with per-studio memberCount", async () => {
    const user = await insertUser();
    const teammate = await insertUser();
    const personal = await insertStudio(user, "personal");
    const team = await insertStudio(teammate, "team");
    await insertMemberRaw(personal.id, user, "admin");
    await insertMemberRaw(team.id, teammate, "admin");
    await insertMemberRaw(team.id, user, "guest");

    const list = await studioService.listUserStudios(user);
    const byId = new Map(list.map((s) => [s.id, s]));

    expect(byId.has(personal.id)).toBe(true);
    expect(byId.has(team.id)).toBe(true);
    expect(byId.get(personal.id)!.memberCount).toBe(1);
    expect(byId.get(team.id)!.memberCount).toBe(2);
  });

  it("orders the personal studio first even when a team studio was created earlier", async () => {
    const user = await insertUser();
    const teammate = await insertUser();
    // team created BEFORE personal → earlier created_at.
    const team = await insertStudio(teammate, "team");
    const personal = await insertStudio(user, "personal");
    await insertMemberRaw(team.id, teammate, "admin");
    await insertMemberRaw(team.id, user, "guest");
    await insertMemberRaw(personal.id, user, "admin");

    const list = await studioService.listUserStudios(user);

    expect(list[0]!.type).toBe("personal");
    expect(list[0]!.id).toBe(personal.id);
    expect(list.map((s) => s.id)).toContain(team.id);
  });

  it("drops a studio whose membership has been soft-deleted", async () => {
    const user = await insertUser();
    const teammate = await insertUser();
    const team = await insertStudio(teammate, "team");
    await insertMemberRaw(team.id, teammate, "admin");
    await insertMemberRaw(team.id, user, "guest");
    expect((await studioService.listUserStudios(user)).map((s) => s.id)).toContain(team.id);

    await softDeleteMember(team.id, user);

    expect((await studioService.listUserStudios(user)).map((s) => s.id)).not.toContain(
      team.id,
    );
  });
});

describe("getStudioMembers — member roster (display name from personal studio)", () => {
  it("lists active members with personal-studio display name, email, role + ISO joinedAt", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    // Each user's display name lives on their personal studio (no users.username).
    const ownerPersonal = await insertStudio(owner, "personal");
    await insertMemberRaw(ownerPersonal.id, owner, "admin");
    const memberPersonal = await insertStudio(member, "personal");
    await insertMemberRaw(memberPersonal.id, member, "admin");
    const team = await insertStudio(owner, "team");
    await insertMemberRaw(team.id, owner, "admin");
    await insertMemberRaw(team.id, member, "guest");

    const members = (await studioService.getStudioMembers(team.slug, owner))
      .members;
    expect(members).toHaveLength(2);
    const byRole = new Map(members.map((m) => [m.role, m]));
    expect(byRole.get("admin")!.userId).toBe(owner);
    expect(byRole.get("guest")!.userId).toBe(member);
    // Display name comes from each member's personal studio name.
    expect(byRole.get("admin")!.name).toBe(`Studio ${ownerPersonal.slug}`);
    expect(byRole.get("guest")!.name).toBe(`Studio ${memberPersonal.slug}`);
    // joinedAt is serialized to an ISO-8601 string.
    expect(byRole.get("admin")!.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("excludes soft-deleted members", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const team = await insertStudio(owner, "team");
    await insertMemberRaw(team.id, owner, "admin");
    await insertMemberRaw(team.id, member, "guest");
    expect(
      (await studioService.getStudioMembers(team.slug, owner)).members,
    ).toHaveLength(2);

    await softDeleteMember(team.id, member);

    const after = (await studioService.getStudioMembers(team.slug, owner)).members;
    expect(after).toHaveLength(1);
    expect(after[0]!.userId).toBe(owner);
  });

  it("returns exactly the creator (admin) for a personal studio", async () => {
    const user = await insertUser();
    const personal = await insertStudio(user, "personal");
    await insertMemberRaw(personal.id, user, "admin");

    const members = (await studioService.getStudioMembers(personal.slug, user))
      .members;
    expect(members).toHaveLength(1);
    expect(members[0]!.userId).toBe(user);
    expect(members[0]!.role).toBe("admin");
  });

  it("throws NotFoundError for a slug with no active studio", async () => {
    await expect(
      studioService.getStudioMembers(
        "no-such-members-slug",
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
