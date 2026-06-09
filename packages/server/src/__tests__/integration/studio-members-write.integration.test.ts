// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio member WRITE-path invariants (slice 3) — the `studioMembersRepo`
 * mutators (upsertMember / softDelete / updateRole) against a real Postgres.
 * These back invite / remove / change-role / transfer-admin. The SQL-level
 * behaviour is invisible to a mocked query builder, so it is pinned here:
 *
 *   - upsertMember: ON CONFLICT (studio_id, user_id) — insert a fresh member,
 *     REJECT an already-active member (no silent role overwrite), and REVIVE a
 *     soft-deleted (previously kicked) row with the new role.
 *   - softDelete: state-only removal — the row physically remains.
 *   - updateRole: flips an active member's role; bumping a second member to
 *     admin while an active admin exists must hit the
 *     `studio_members_one_admin_per_studio` partial unique (transfer
 *     demotes-then-promotes in one tx, so the repo must not silently allow two
 *     active admins).
 *
 * Runs against the testcontainer Postgres started by global-setup.ts. Seeding
 * uses a narrow raw `postgres` client; assertions call the real repo.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/domain (barrel pulls agent/llm → the
// `ai` SDK → @opentelemetry/api whose broken ESM crashes the loader). Same
// guard the studio-auth / credit-balance suites use.
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
    connection: { application_name: "studio-members-write-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/** Insert a fresh user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `smw-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let studioSeq = 0;
/** Insert a fresh team studio created by the given user. */
async function insertStudio(createdByUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${`smw-studio-${studioSeq++}`}, 'team', 'Test Team Studio')
    RETURNING id
  `;
  return rows[0]!.id;
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

async function softDeleteMemberRaw(studioId: string, userId: string): Promise<void> {
  await sql`
    UPDATE studio_members SET deleted_at = now()
    WHERE studio_id = ${studioId} AND user_id = ${userId}
  `;
}

/** Read the raw stored role, bypassing the repo's soft-delete join. */
async function rawRole(studioId: string, userId: string): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM studio_members WHERE studio_id = ${studioId} AND user_id = ${userId}
  `;
  return rows[0]?.role ?? null;
}

async function rawDeletedAt(studioId: string, userId: string): Promise<Date | null> {
  const rows = await sql<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM studio_members WHERE studio_id = ${studioId} AND user_id = ${userId}
  `;
  return rows[0]?.deleted_at ?? null;
}

describe("upsertMember — invite (insert / active-collision / revive)", () => {
  it("inserts a fresh active member and returns true", async () => {
    const admin = await insertUser();
    const invitee = await insertUser();
    const studio = await insertStudio(admin);

    const ok = await studioMembersRepo.upsertMember(studio, invitee, "member", admin);

    expect(ok).toBe(true);
    expect(await studioMembersRepo.getRole(studio, invitee)).toBe("member");
  });

  it("returns false when the user is ALREADY an active member (no silent role overwrite)", async () => {
    const admin = await insertUser();
    const invitee = await insertUser();
    const studio = await insertStudio(admin);
    await insertMemberRaw(studio, invitee, "member");

    const ok = await studioMembersRepo.upsertMember(studio, invitee, "creator", admin);

    expect(ok).toBe(false);
    expect(await rawRole(studio, invitee)).toBe("member"); // rejected upsert left role untouched
  });

  it("revives a soft-deleted (previously kicked) member with the new role, returns true", async () => {
    const admin = await insertUser();
    const invitee = await insertUser();
    const studio = await insertStudio(admin);
    await insertMemberRaw(studio, invitee, "member");
    await softDeleteMemberRaw(studio, invitee);
    expect(await studioMembersRepo.getRole(studio, invitee)).toBeNull();

    const ok = await studioMembersRepo.upsertMember(studio, invitee, "creator", admin);

    expect(ok).toBe(true);
    expect(await studioMembersRepo.getRole(studio, invitee)).toBe("creator");
    expect(await rawDeletedAt(studio, invitee)).toBeNull(); // revived, deleted_at cleared
  });
});

describe("softDelete — remove member (state-only)", () => {
  it("soft-deletes an active member, returns true; getRole→null but the row physically remains", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(admin);
    await insertMemberRaw(studio, member, "member");

    const ok = await studioMembersRepo.softDelete(studio, member);

    expect(ok).toBe(true);
    expect(await studioMembersRepo.getRole(studio, member)).toBeNull();
    expect(await rawRole(studio, member)).toBe("member"); // not destroyed
  });

  it("returns false for a non-member / already-removed user", async () => {
    const admin = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudio(admin);

    expect(await studioMembersRepo.softDelete(studio, stranger)).toBe(false);
  });
});

describe("updateRole — change role / transfer steps", () => {
  it("changes an active member's role (member→creator), returns true", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(admin);
    await insertMemberRaw(studio, member, "member");

    const ok = await studioMembersRepo.updateRole(studio, member, "creator");

    expect(ok).toBe(true);
    expect(await studioMembersRepo.getRole(studio, member)).toBe("creator");
  });

  it("returns false for a non-member", async () => {
    const admin = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudio(admin);

    expect(await studioMembersRepo.updateRole(studio, stranger, "creator")).toBe(false);
  });

  it("rejects bumping a member to admin while an active admin exists (one-admin partial unique guards transfer ordering)", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(admin);
    await insertMemberRaw(studio, admin, "admin");
    await insertMemberRaw(studio, member, "member");

    // Transfer demotes the old admin FIRST in the same tx; a bare bump to a
    // second active admin must hit studio_members_one_admin_per_studio.
    await expect(studioMembersRepo.updateRole(studio, member, "admin")).rejects.toThrow();
  });
});
