// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * setup-studio critical-path invariants — the second registration step
 * (`studioService.createPersonalStudio` + the `studios` partial unique
 * indexes), against a real Postgres.
 *
 * Auth + data integrity are CLAUDE.md critical paths. The guarantees here
 * are SQL-level and can only be verified against real Postgres (a mocked
 * query builder returns whatever the test stages regardless of the
 * partial-unique / transaction semantics):
 *
 *   1. slug is globally unique — two concurrent setup-studio calls for the
 *      same slug → exactly one succeeds, the other gets a typed
 *      ConflictError (409), never a raw 500 (`studios_slug_idx`).
 *   2. one personal studio per user — a second setup-studio for the same
 *      user is rejected (`studios_owner_personal_idx`).
 *   3. create studio + admin member row is atomic — on success BOTH rows
 *      exist; if the admin insert fails, the studio insert rolls back
 *      (no orphan studio).
 *   4/7. the onboarding gate — getPersonalStudio returns null before
 *      setup and the studio after, so `/auth/me` can report
 *      personalStudio==null for a half-onboarded account.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts.
 * Seeding uses a narrow raw `postgres` client; the assertions call the
 * real `studioService` (core's env-bound `db`, pointed at the same
 * container via the injected config).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/domain (studioService → studio.service
// → @breatic/domain barrel pulls agent/llm → the `ai` SDK → @opentelemetry/api,
// whose ESM build Node's native ESM rejects). This suite never calls any ai
// function; the stubs keep that broken ESM chain from loading at import time.
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

// Wrap @breatic/domain's `studioMembersRepo.insertAdmin` in a spy that
// delegates to the REAL implementation by default — so every test runs
// against real Postgres — while letting the rollback test force a single
// throw to prove the studio insert is rolled back atomically. (A plain
// `vi.spyOn` can't redefine the non-configurable ESM export, so the
// interception has to be installed in the hoisted mock factory.)
const { insertAdminSpy } = vi.hoisted(() => ({ insertAdminSpy: vi.fn() }));
vi.mock("@breatic/domain", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  const realRepo = actual.studioMembersRepo as {
    insertAdmin: (...args: unknown[]) => Promise<void>;
  };
  insertAdminSpy.mockImplementation((...args: unknown[]) =>
    realRepo.insertAdmin(...args),
  );
  return {
    ...actual,
    studioMembersRepo: { ...realRepo, insertAdmin: insertAdminSpy },
  };
});

import postgres from "postgres";
import { initCore, ConflictError } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
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

const PG_DRIVER_LOCAL = "setup-studio-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = inject("DATABASE_URL");
  sql = postgres(url, {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

// Unique-email counter + unique slug counter so each test seeds
// independent entities (no truncation between tests).
let seq = 0;

/** Insert a fresh user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `ss-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return rows[0]!.id;
}

let slugSeq = 0;
/** A fresh slug that satisfies the format regex (lowercase, 6–39 chars). */
function freshSlug(): string {
  return `handle-${slugSeq++}`;
}

/** Count active studios created by a user. */
async function countPersonalStudios(userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM studios
    WHERE created_by_user_id = ${userId}
      AND type = 'personal'
      AND deleted_at IS NULL
  `;
  return rows[0]!.n;
}

/** Count studio_members rows for a studio with a given role. */
async function countMembers(studioId: string, role: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM studio_members
    WHERE studio_id = ${studioId} AND role = ${role} AND deleted_at IS NULL
  `;
  return rows[0]!.n;
}

describe("createPersonalStudio — onboarding gate (闸门 data: invariant 4/7)", () => {
  it("getPersonalStudio is null before setup, and returns the studio after", async () => {
    const user = await insertUser();

    // Half-onboarded account (registered, no slug) → null gate signal.
    expect(await studioService.getPersonalStudio(user)).toBeNull();

    const slug = freshSlug();
    const studio = await studioService.createPersonalStudio(user, slug);

    expect(studio.slug).toBe(slug);
    // Display name initially equals the slug.
    expect(studio.name).toBe(slug);
    expect(studio.type).toBe("personal");
    expect(studio.createdByUserId).toBe(user);

    const after = await studioService.getPersonalStudio(user);
    expect(after?.id).toBe(studio.id);
    expect(after?.slug).toBe(slug);
  });
});

describe("createPersonalStudio — studio + admin atomicity (invariant 3, 数据完整性)", () => {
  it("writes exactly one studio row + one admin studio_members row", async () => {
    const user = await insertUser();
    const studio = await studioService.createPersonalStudio(user, freshSlug());

    expect(await countPersonalStudios(user)).toBe(1);
    expect(await countMembers(studio.id, "admin")).toBe(1);
    // The creator IS the admin (loadStudioRole resolves it).
    expect(await studioMembersRepo.getRole(studio.id, user)).toBe("admin");
  });

  it("rolls back the studio insert when the admin insert fails (no orphan studio)", async () => {
    const user = await insertUser();
    const slug = freshSlug();
    // Force the admin insert (the second write in the transaction) to
    // throw exactly once. If the studio insert were NOT in the same
    // transaction, the studio row would leak as an orphan with no admin.
    insertAdminSpy.mockRejectedValueOnce(new Error("forced admin-insert failure"));

    await expect(
      studioService.createPersonalStudio(user, slug),
    ).rejects.toThrow("forced admin-insert failure");

    // The whole transaction rolled back: no studio with that slug, and no
    // personal studio for the user.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM studios WHERE slug = ${slug} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(0);
    expect(await countPersonalStudios(user)).toBe(0);
  });
});

describe("createPersonalStudio — slug global uniqueness (invariant 1)", () => {
  it("two concurrent setup-studio calls for the SAME slug → one wins, one ConflictError (409, not 500)", async () => {
    const userA = await insertUser();
    const userB = await insertUser();
    const slug = freshSlug();

    const results = await Promise.allSettled([
      studioService.createPersonalStudio(userA, slug),
      studioService.createPersonalStudio(userB, slug),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one winner.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser gets a typed ConflictError → maps to HTTP 409 (NOT a raw
    // 500). Asserting the type + statusCode pins the wire contract.
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);

    // The slug exists exactly once globally.
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM studios
      WHERE slug = ${slug} AND deleted_at IS NULL
    `;
    expect(rows[0]!.n).toBe(1);
  });
});

describe("createPersonalStudio — one personal studio per user (invariant 2)", () => {
  it("a second setup-studio for the same user is rejected with ConflictError", async () => {
    const user = await insertUser();
    await studioService.createPersonalStudio(user, freshSlug());

    // Second attempt (a different slug) still violates the
    // one-personal-per-user partial unique index.
    await expect(
      studioService.createPersonalStudio(user, freshSlug()),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await countPersonalStudios(user)).toBe(1);
  });
});
