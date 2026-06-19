// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio membership critical-path invariants — `studioMembersRepo` and
 * the "one admin per studio" partial unique index, against a real
 * Postgres (slice 1, migration 0023).
 *
 * Studio-level auth (鉴权 — a CLAUDE.md critical path) lives in two
 * guarantees whose correctness is SQL-level and can only be verified
 * against real Postgres (a mocked query builder would return whatever the
 * test stages regardless of the WHERE/JOIN/partial-index clauses):
 *
 *   1. getRole       — returns the active studio role, or null. The
 *                      `studios` inner-join + `deleted_at IS NULL` filters
 *                      hide a soft-deleted studio OR a soft-deleted member
 *                      row, collapsing both (plus "not a member") to null.
 *   2. insertAdmin + the `studio_members_one_admin_per_studio` partial
 *                      unique index — a studio can have at most ONE active
 *                      admin (数据完整性 invariant). A soft-deleted admin
 *                      does NOT block a fresh one (partial index excludes
 *                      deleted_at IS NOT NULL); admins across different
 *                      studios never collide.
 *
 * Soft-delete is state-only: the row physically stays in the table, so the
 * test asserts the underlying data is NOT destroyed (mirrors the
 * credit-balance integration suite).
 *
 * Runs against the testcontainer Postgres started by global-setup.ts.
 * Seeding uses a narrow raw `postgres` client; the assertions call the
 * real `studioMembersRepo` (core's env-bound `db`, pointed at the same
 * container via the injected config).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/domain. The domain barrel pulls
// agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build uses
// bare relative imports that Node's native ESM rejects. This suite never
// calls any ai function; the stubs just keep that broken ESM chain from
// loading at import time (same guard the credit-balance suite uses).
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

// integration-setup.ts injects the container URLs into process.env. Each
// suite injects the validated config so the repo's env-bound `db` Proxy
// resolves to the testcontainer. Guarded because the worker process is
// shared (singleFork) with sibling suites that may have already inited.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "studio-members-test-driver";

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

// Unique-email counter so every seeded user is independent across tests
// (no truncation between tests — fresh entities avoid collisions).
let seq = 0;

/** Insert a fresh user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `sm-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return rows[0]!.id;
}

let studioSeq = 0;
/** Insert a fresh personal studio created by the given user. */
async function insertStudio(createdByUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${`test-studio-${studioSeq++}`}, 'personal', 'Test Studio')
    RETURNING id
  `;
  return rows[0]!.id;
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

async function softDeleteStudio(studioId: string): Promise<void> {
  await sql`UPDATE studios SET deleted_at = now() WHERE id = ${studioId}`;
}

async function softDeleteMember(studioId: string, userId: string): Promise<void> {
  await sql`
    UPDATE studio_members SET deleted_at = now()
    WHERE studio_id = ${studioId} AND user_id = ${userId}
  `;
}

/** Read the raw stored role, bypassing the repo's soft-delete join. */
async function rawRole(studioId: string, userId: string): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM studio_members
    WHERE studio_id = ${studioId} AND user_id = ${userId}
  `;
  return rows[0]?.role ?? null;
}

describe("getRole — resolves studio role, hides soft-deleted (state-only)", () => {
  it("returns 'admin' / 'guest' for active members and null for a non-member", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudio(owner);
    await insertMemberRaw(studio, owner, "admin");
    await insertMemberRaw(studio, member, "guest");

    expect(await studioMembersRepo.getRole(studio, owner)).toBe("admin");
    expect(await studioMembersRepo.getRole(studio, member)).toBe("guest");
    expect(await studioMembersRepo.getRole(studio, stranger)).toBeNull();
  });

  it("returns null for a soft-deleted studio, though the member row physically remains", async () => {
    const owner = await insertUser();
    const studio = await insertStudio(owner);
    await insertMemberRaw(studio, owner, "admin");
    expect(await studioMembersRepo.getRole(studio, owner)).toBe("admin");

    await softDeleteStudio(studio);
    // Read is hidden by the studios-join + deleted_at IS NULL filter…
    expect(await studioMembersRepo.getRole(studio, owner)).toBeNull();
    // …but the underlying membership is NOT destroyed (soft-delete only).
    expect(await rawRole(studio, owner)).toBe("admin");
  });

  it("returns null when the member row itself is soft-deleted", async () => {
    const owner = await insertUser();
    const studio = await insertStudio(owner);
    await insertMemberRaw(studio, owner, "admin");

    await softDeleteMember(studio, owner);
    expect(await studioMembersRepo.getRole(studio, owner)).toBeNull();
    expect(await rawRole(studio, owner)).toBe("admin");
  });
});

describe("insertAdmin + one-admin-per-studio partial unique (数据完整性)", () => {
  it("writes the creator's admin row with addedBy null", async () => {
    const owner = await insertUser();
    const studio = await insertStudio(owner);

    await studioMembersRepo.insertAdmin(studio, owner);

    expect(await studioMembersRepo.getRole(studio, owner)).toBe("admin");
    const rows = await sql<{ added_by: string | null }[]>`
      SELECT added_by FROM studio_members
      WHERE studio_id = ${studio} AND user_id = ${owner}
    `;
    expect(rows[0]!.added_by).toBeNull();
  });

  it("rejects a SECOND active admin in the same studio (one studio one admin)", async () => {
    const owner = await insertUser();
    const second = await insertUser();
    const studio = await insertStudio(owner);
    await studioMembersRepo.insertAdmin(studio, owner);

    await expect(studioMembersRepo.insertAdmin(studio, second)).rejects.toThrow();
  });

  it("allows a fresh admin after the previous admin is soft-deleted (partial index excludes deleted rows)", async () => {
    const owner = await insertUser();
    const second = await insertUser();
    const studio = await insertStudio(owner);
    await studioMembersRepo.insertAdmin(studio, owner);
    await softDeleteMember(studio, owner);

    await expect(
      studioMembersRepo.insertAdmin(studio, second),
    ).resolves.toBeUndefined();
    expect(await studioMembersRepo.getRole(studio, second)).toBe("admin");
  });

  it("allows admins in two different studios (partial unique is scoped per studio)", async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const studioA = await insertStudio(ownerA);
    const studioB = await insertStudio(ownerB);
    await studioMembersRepo.insertAdmin(studioA, ownerA);

    await expect(
      studioMembersRepo.insertAdmin(studioB, ownerB),
    ).resolves.toBeUndefined();
  });
});
