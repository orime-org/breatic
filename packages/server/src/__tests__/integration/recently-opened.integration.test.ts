// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * "Recent" landing critical-path invariants — `recentService.recordOpen` +
 * `recentService.listRecent` against a real Postgres.
 *
 * The recent feed is a CLAUDE.md critical path (auth + data integrity): it must
 * NEVER surface a project the viewer cannot enter (kicked from it, never a
 * member of it, or project soft-deleted). Those guarantees are
 * SQL-level — the access-filter WHERE clause, the composite-PK upsert revive,
 * and the `ON CONFLICT DO UPDATE last_opened_at = now()` only behave correctly
 * against real Postgres, so a mocked query builder cannot prove them.
 *
 * Seeding uses a narrow raw `postgres` client; the assertions call the real
 * service (core's env-bound `db`, pointed at the testcontainer via the injected
 * config) and the real `assertAccess` (project auth). Design doc
 * the private engineering record §3-4, C2-C3.
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

import postgres from "postgres";
import { initCore, NotFoundError } from "@breatic/core";
import * as recentService from "@server/modules/recent/recent.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "recently-opened-test-driver";

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

let seq = 0;

/** Insert a fresh user; returns its id. */
async function insertUser(): Promise<string> {
  const email = `ro-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return rows[0]!.id;
}

let slugSeq = 0;
/** Insert a fresh studio; returns its id. */
async function insertStudio(createdByUserId: string): Promise<string> {
  const slug = `ro-studio-${slugSeq++}`;
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
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, ${role})
  `;
}

let projSeq = 0;
/** Insert a fresh project (+ its owner row) in a studio; returns the project id. */
async function insertProject(
  studioId: string,
  ownerUserId: string,
): Promise<string> {
  const slug = `ro-project-${projSeq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${ownerUserId}, ${`Project ${slug}`}, ${slug})
    RETURNING id
  `;
  const projectId = rows[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerUserId}, 'owner', null)
  `;
  return projectId;
}

/** Seed a non-owner project_members row directly. */
async function insertProjectMember(
  projectId: string,
  userId: string,
  role: "editor" | "viewer",
  deleted = false,
): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by, deleted_at)
    VALUES (${projectId}, ${userId}, ${role}, null, ${deleted ? sql`now()` : null})
  `;
}

/** Soft-delete a project (stamp deleted_at). */
async function softDeleteProject(projectId: string): Promise<void> {
  await sql`UPDATE projects SET deleted_at = now() WHERE id = ${projectId}`;
}

/**
 * Seed a project_last_opened row directly with an explicit timestamp, so
 * ordering / staleness can be asserted deterministically (recordOpen always
 * stamps now(), which is not controllable for ordering assertions).
 */
async function seedOpen(
  userId: string,
  projectId: string,
  openedAt: string,
): Promise<void> {
  await sql`
    INSERT INTO project_last_opened (user_id, project_id, last_opened_at, created_at)
    VALUES (${userId}, ${projectId}, ${openedAt}, ${openedAt})
  `;
}

/** Read the (single) project_last_opened row for a user+project, if any. */
async function readOpenRow(
  userId: string,
  projectId: string,
): Promise<{ lastOpenedAt: Date; createdAt: Date } | null> {
  const rows = await sql<{ last_opened_at: Date; created_at: Date }[]>`
    SELECT last_opened_at, created_at FROM project_last_opened
    WHERE user_id = ${userId} AND project_id = ${projectId}
  `;
  return rows[0]
    ? { lastOpenedAt: rows[0].last_opened_at, createdAt: rows[0].created_at }
    : null;
}

/** Count project_last_opened rows for a user+project (upsert ⇒ at most 1). */
async function openRowCount(userId: string, projectId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM project_last_opened
    WHERE user_id = ${userId} AND project_id = ${projectId}
  `;
  return rows[0]!.n;
}

describe("recordOpen — upsert + access gate (C2, critical path)", () => {
  it("first open inserts one row; access-gated by membership", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner);

    expect(await openRowCount(owner, pid)).toBe(0);
    await recentService.recordOpen(pid, owner);
    expect(await openRowCount(owner, pid)).toBe(1);
    const row = await readOpenRow(owner, pid);
    expect(row).not.toBeNull();
  });

  it("re-open updates last_opened_at in place (no duplicate; created_at preserved)", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner);

    // Seed a stale open far in the past, then re-open via the service.
    await seedOpen(owner, pid, "2020-01-01T00:00:00Z");
    const before = await readOpenRow(owner, pid);

    await recentService.recordOpen(pid, owner);

    expect(await openRowCount(owner, pid)).toBe(1); // composite PK → upsert, not a 2nd row
    const after = await readOpenRow(owner, pid);
    expect(after!.lastOpenedAt.getTime()).toBeGreaterThan(
      before!.lastOpenedAt.getTime(),
    );
    // created_at is the FIRST-open timestamp; the upsert must not bump it.
    expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
  });

  it("rejects recording an open the caller cannot access (404, no row written)", async () => {
    const owner = await insertUser();
    const stranger = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner);

    await expect(recentService.recordOpen(pid, stranger)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await openRowCount(stranger, pid)).toBe(0);
  });
});

describe("listRecent — ordering (C3)", () => {
  it("returns opened projects newest-first; re-open floats a project to the top", async () => {
    const user = await insertUser();
    const studioId = await insertStudio(user);
    await insertStudioMember(studioId, user, "admin");
    const pA = await insertProject(studioId, user);
    const pB = await insertProject(studioId, user);
    const pC = await insertProject(studioId, user);

    await seedOpen(user, pA, "2026-01-01T00:00:00Z"); // oldest
    await seedOpen(user, pB, "2026-02-01T00:00:00Z");
    await seedOpen(user, pC, "2026-03-01T00:00:00Z"); // newest

    const ordered = (await recentService.listRecent(user)).map((r) => r.projectId);
    expect(ordered.indexOf(pC)).toBeLessThan(ordered.indexOf(pB));
    expect(ordered.indexOf(pB)).toBeLessThan(ordered.indexOf(pA));

    // Re-open the oldest → now() floats it above the others.
    await recentService.recordOpen(pA, user);
    const reordered = (await recentService.listRecent(user)).map((r) => r.projectId);
    expect(reordered[0]).toBe(pA);
  });

  it("carries name / slug / thumbnailUrl / studio identity / role / lastOpenedAt", async () => {
    const user = await insertUser();
    const studioId = await insertStudio(user);
    await insertStudioMember(studioId, user, "admin");
    const pid = await insertProject(studioId, user); // user is the owner
    await seedOpen(user, pid, "2026-04-01T00:00:00Z");

    const item = (await recentService.listRecent(user)).find(
      (r) => r.projectId === pid,
    )!;
    expect(item.name).toMatch(/^Project ro-project-/);
    expect(item.slug).toMatch(/^ro-project-/);
    expect(item.studioId).toBe(studioId);
    expect(item.studioName).toMatch(/^Studio ro-studio-/);
    expect(item.myRole).toBe("owner"); // from the join on project_members
    expect(item.lastOpenedAt).toBeInstanceOf(Date);
  });
});

describe("listRecent — access filter (C3, CRITICAL: never leak inaccessible projects)", () => {
  it("includes projects with an active membership; EXCLUDES kicked / never-joined / soft-deleted", async () => {
    const user = await insertUser();
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, user, "guest");

    // (a) project the user is a viewer on → IN.
    const pVisible = await insertProject(studioId, owner);
    await insertProjectMember(pVisible, user, "viewer");

    // (b) project the user is an editor on → IN.
    const pPrivateMember = await insertProject(studioId, owner);
    await insertProjectMember(pPrivateMember, user, "editor");

    // (c) project the user opened then got KICKED from (member row soft-deleted)
    //     → OUT (no leak after access revoked).
    const pKicked = await insertProject(studioId, owner);
    await insertProjectMember(pKicked, user, "viewer", true);

    // (d) a project in the user's studio they have no membership on, with a
    //     stale open row → OUT (they cannot enter it, so it is not recent).
    const pOthersPrivate = await insertProject(studioId, owner);

    // (e) soft-deleted project the user did open → OUT.
    const pDeleted = await insertProject(studioId, owner);
    await insertProjectMember(pDeleted, user, "viewer");

    // The user has an open row for every one of them (incl. ones now inaccessible).
    for (const pid of [
      pVisible,
      pPrivateMember,
      pKicked,
      pOthersPrivate,
      pDeleted,
    ]) {
      await seedOpen(user, pid, "2026-05-01T00:00:00Z");
    }
    await softDeleteProject(pDeleted);

    const ids = new Set(
      (await recentService.listRecent(user)).map((r) => r.projectId),
    );
    expect(ids.has(pVisible)).toBe(true);
    expect(ids.has(pPrivateMember)).toBe(true);
    expect(ids.has(pKicked)).toBe(false);
    expect(ids.has(pOthersPrivate)).toBe(false);
    expect(ids.has(pDeleted)).toBe(false);
  });

  it("a studio member with an open row but no membership on the project is excluded", async () => {
    // Studio membership alone does not let anyone enter a project, so a project
    // they cannot open never shows up as recent.
    const user = await insertUser();
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, user, "guest");
    const pVisibleNoRow = await insertProject(studioId, owner);
    await seedOpen(user, pVisibleNoRow, "2026-05-02T00:00:00Z");

    const ids = new Set(
      (await recentService.listRecent(user)).map((r) => r.projectId),
    );
    expect(ids.has(pVisibleNoRow)).toBe(false);
  });

  it("a non-studio-member with a stale open row on a project is excluded", async () => {
    const user = await insertUser();
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    // `user` is NOT a member of the studio (was removed).
    const pVisible = await insertProject(studioId, owner);
    await seedOpen(user, pVisible, "2026-05-03T00:00:00Z");

    const ids = new Set(
      (await recentService.listRecent(user)).map((r) => r.projectId),
    );
    expect(ids.has(pVisible)).toBe(false);
  });
});
