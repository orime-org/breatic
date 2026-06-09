// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Team studio creation (studio-team-create slice) — `createTeamStudio` against
 * a real Postgres. Creating a studio is the 数据完整性 critical path, so the
 * service-level invariants are pinned end-to-end:
 *
 *   - creates a `type='team'` studio + the creator's sole `admin`
 *     `studio_members` row, atomically (mirrors createPersonalStudio).
 *   - one user may create many team studios (not blocked by the
 *     one-personal-per-user partial index).
 *   - a duplicate slug loses the unique-index race → ConflictError (409).
 *   - the per-user team-studio limit (50, user decision B) is enforced; the
 *     count is scoped to the creator's OWN active team studios.
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

import postgres from "postgres";
import { initCore } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { studioService } from "@server/modules";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "team-studio-create-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let userSeq = 0;
/** Insert a user; returns { id, email }. */
async function insertUser(): Promise<{ id: string; email: string }> {
  const email = `tsc-${userSeq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return { id: rows[0]!.id, email };
}

let slugSeq = 0;
/** A unique, well-formed studio slug (lowercase, 6–39 chars, SLUG_REGEX). */
function uniqueSlug(): string {
  return `tcs-${(slugSeq++).toString().padStart(6, "0")}`;
}

/** Seed N team studios owned by `userId` directly (bypassing the service). */
async function seedTeamStudios(userId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      INSERT INTO studios (created_by_user_id, slug, type, name)
      VALUES (${userId}, ${uniqueSlug()}, 'team', 'Seed')
    `;
  }
}

describe("createTeamStudio", () => {
  it("creates a team studio with the creator as its sole admin, atomically", async () => {
    const user = await insertUser();
    const studio = await studioService.createTeamStudio(user.id, "My Team", uniqueSlug());

    expect(studio.type).toBe("team");
    expect(studio.name).toBe("My Team");
    expect(studio.createdByUserId).toBe(user.id);
    // creator is the studio admin
    expect(await studioMembersRepo.getRole(studio.id, user.id)).toBe("admin");
    // exactly one admin row exists for the studio
    const admins = await sql<{ user_id: string }[]>`
      SELECT user_id FROM studio_members
      WHERE studio_id = ${studio.id} AND role = 'admin' AND deleted_at IS NULL
    `;
    expect(admins).toHaveLength(1);
    expect(admins[0]!.user_id).toBe(user.id);
  });

  it("keeps name and slug independent (C 方案 — both hand-typed)", async () => {
    const user = await insertUser();
    const slug = uniqueSlug();
    const studio = await studioService.createTeamStudio(user.id, "Totally Different Name", slug);
    expect(studio.slug).toBe(slug);
    expect(studio.name).toBe("Totally Different Name");
  });

  it("lets one user create multiple team studios", async () => {
    const user = await insertUser();
    const a = await studioService.createTeamStudio(user.id, "A", uniqueSlug());
    const b = await studioService.createTeamStudio(user.id, "B", uniqueSlug());
    expect(a.id).not.toBe(b.id);
    expect(await studioMembersRepo.getRole(a.id, user.id)).toBe("admin");
    expect(await studioMembersRepo.getRole(b.id, user.id)).toBe("admin");
  });

  it("rejects a duplicate slug with Conflict (409)", async () => {
    const u1 = await insertUser();
    const u2 = await insertUser();
    const slug = uniqueSlug();
    await studioService.createTeamStudio(u1.id, "First", slug);
    await expect(
      studioService.createTeamStudio(u2.id, "Second", slug),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("leaves no orphan studio row when the slug collides (atomic rollback)", async () => {
    const u1 = await insertUser();
    const u2 = await insertUser();
    const slug = uniqueSlug();
    await studioService.createTeamStudio(u1.id, "First", slug);
    await expect(
      studioService.createTeamStudio(u2.id, "Second", slug),
    ).rejects.toMatchObject({ statusCode: 409 });
    // exactly one studio carries that slug — the failed attempt left nothing
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM studios WHERE slug = ${slug} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
  });

  it("rejects creating beyond the per-user team-studio limit (50)", async () => {
    const user = await insertUser();
    await seedTeamStudios(user.id, 50);
    await expect(
      studioService.createTeamStudio(user.id, "Over Limit", uniqueSlug()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows the 50th team studio (limit is >=50, not >50)", async () => {
    const user = await insertUser();
    await seedTeamStudios(user.id, 49);
    const studio = await studioService.createTeamStudio(user.id, "Fiftieth", uniqueSlug());
    expect(studio.type).toBe("team");
  });

  it("counts only the creator's OWN active team studios toward the limit", async () => {
    const user = await insertUser();
    const other = await insertUser();
    await seedTeamStudios(other.id, 50); // another user's 50 must not block
    const studio = await studioService.createTeamStudio(user.id, "Mine", uniqueSlug());
    expect(studio.type).toBe("team");
  });
});

describe("checkStudioSlug", () => {
  it("returns available for a fresh, well-formed slug", async () => {
    expect(await studioService.checkStudioSlug(uniqueSlug())).toEqual({
      available: true,
    });
  });

  it("returns taken for an existing studio slug", async () => {
    const user = await insertUser();
    const slug = uniqueSlug();
    await studioService.createTeamStudio(user.id, "X", slug);
    expect(await studioService.checkStudioSlug(slug)).toEqual({
      available: false,
      reason: "taken",
    });
  });

  it("returns format for a malformed slug", async () => {
    expect(await studioService.checkStudioSlug("Bad Slug!")).toEqual({
      available: false,
      reason: "format",
    });
  });

  it("returns length for a too-short (but well-formed) slug", async () => {
    expect(await studioService.checkStudioSlug("abc")).toEqual({
      available: false,
      reason: "length",
    });
  });
});
