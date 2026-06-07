// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Slice 2 open-baseline access critical-path invariants —
 * `projectService.loadForViewer` + `projectService.listByStudioForViewer`
 * + `projectMembersRepo.materializeBaselineViewer` against a real Postgres.
 *
 * Open-baseline access is a CLAUDE.md critical path (鉴权 + 数据完整性). The
 * guarantees are SQL-level and a mocked query builder cannot prove them — the
 * visibility WHERE clause, the `ON CONFLICT ... WHERE deleted_at IS NOT NULL`
 * revive semantics, the composite-PK concurrency tie-break, and the partial
 * unique "one owner per project" index only behave correctly against real
 * Postgres. Design doc §4 invariants 1–4 + 3b.
 *
 * Seeding uses a narrow raw `postgres` client; the assertions call the real
 * service (core's env-bound `db`, pointed at the testcontainer via the
 * injected config) and the real `loadStudioRole` (domain).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing the project service (→ @breatic/domain barrel
// pulls agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build
// Node's native ESM rejects). This suite never calls any ai function.
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
import { initCore, NotFoundError, projectMembersRepo } from "@breatic/core";
import * as projectService from "@server/modules/project/project.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "project-visibility-test-driver";

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
  const email = `pv-${seq++}@example.com`;
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
  const slug = `pv-studio-${slugSeq++}`;
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
  role: "admin" | "member",
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
  visibility: "studio" | "private",
): Promise<string> {
  const slug = `pv-project-${projSeq++}`;
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

/** Count active member rows for a user on a project. */
async function activeMemberCount(projectId: string, userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM project_members
    WHERE project_id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0]!.n;
}

/** Count active owner rows on a project. */
async function ownerCount(projectId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM project_members
    WHERE project_id = ${projectId} AND role = 'owner' AND deleted_at IS NULL
  `;
  return rows[0]!.n;
}

describe("listByStudioForViewer — visibility matrix (invariant #1)", () => {
  it("member sees studio-visible + own-role private; NOT others' private; admin sees all", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const stranger = await insertUser();
    const studioId = await insertStudio(admin);
    await insertStudioMember(studioId, admin, "admin");
    await insertStudioMember(studioId, member, "member");

    const pStudio = await insertProject(studioId, admin, "studio");
    const pPrivateMember = await insertProject(studioId, member, "private");
    const pPrivateAdmin = await insertProject(studioId, admin, "private");

    // Member: studio-visible (no role yet) + own private; NOT admin's private.
    const asMember = await projectService.listByStudioForViewer(studioId, member);
    const memberIds = new Set(asMember.map((p) => p.id));
    expect(memberIds.has(pStudio)).toBe(true);
    expect(memberIds.has(pPrivateMember)).toBe(true);
    expect(memberIds.has(pPrivateAdmin)).toBe(false);
    // studio-visible project the member has not entered → myRole null.
    expect(asMember.find((p) => p.id === pStudio)!.myRole).toBeNull();
    expect(asMember.find((p) => p.id === pPrivateMember)!.myRole).toBe("owner");

    // Admin: sees ALL, including the member's private (myRole null there).
    const asAdmin = await projectService.listByStudioForViewer(studioId, admin);
    const adminIds = new Set(asAdmin.map((p) => p.id));
    expect(adminIds.has(pStudio)).toBe(true);
    expect(adminIds.has(pPrivateMember)).toBe(true);
    expect(adminIds.has(pPrivateAdmin)).toBe(true);
    expect(asAdmin.find((p) => p.id === pPrivateMember)!.myRole).toBeNull();

    // Non-member: no projects (guest shell).
    expect(await projectService.listByStudioForViewer(studioId, stranger)).toEqual([]);
  });

  it("carries slug + visibility on each summary row", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner, "studio");

    const list = await projectService.listByStudioForViewer(studioId, owner);
    const row = list.find((p) => p.id === pid)!;
    expect(row.visibility).toBe("studio");
    expect(row.slug).toMatch(/^pv-project-/);
    expect(row.studioId).toBe(studioId);
  });
});

describe("loadForViewer — open-baseline materialize (invariants #2 #3 #3b #4)", () => {
  it("materializes a viewer row on first entry; idempotent on re-entry (#2 #3)", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, member, "member");
    const pid = await insertProject(studioId, owner, "studio");

    // #2 — not a project member before entry.
    expect(await projectMembersRepo.getRole(pid, member)).toBeNull();

    const first = await projectService.loadForViewer(pid, member);
    expect(first.myRole).toBe("viewer");
    expect(await projectMembersRepo.getRole(pid, member)).toBe("viewer");

    // #3 — re-entry is a no-op (still exactly one active viewer row).
    const second = await projectService.loadForViewer(pid, member);
    expect(second.myRole).toBe("viewer");
    expect(await activeMemberCount(pid, member)).toBe(1);

    // #4 — materialize never forged a second owner.
    expect(await ownerCount(pid)).toBe(1);
  });

  it("converges to a single row under concurrent first entries (#3)", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, member, "member");
    const pid = await insertProject(studioId, owner, "studio");

    const results = await Promise.allSettled([
      projectService.loadForViewer(pid, member),
      projectService.loadForViewer(pid, member),
      projectService.loadForViewer(pid, member),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await activeMemberCount(pid, member)).toBe(1);
    expect(await projectMembersRepo.getRole(pid, member)).toBe("viewer");
  });

  it("revives a soft-deleted (previously-removed) member on baseline re-entry (#3b)", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, member, "member");
    const pid = await insertProject(studioId, owner, "studio");
    // Member was invited then removed → a soft-deleted row exists.
    await insertProjectMember(pid, member, "viewer", true);
    expect(await projectMembersRepo.getRole(pid, member)).toBeNull();

    const result = await projectService.loadForViewer(pid, member);
    expect(result.myRole).toBe("viewer");
    // Revived to an ACTIVE viewer (so collab's loadProjectRole accepts the WS).
    expect(await projectMembersRepo.getRole(pid, member)).toBe("viewer");
    expect(await activeMemberCount(pid, member)).toBe(1);
  });
});

describe("materializeBaselineViewer — never downgrades an active member", () => {
  it("is a no-op against an active editor (no downgrade to viewer)", async () => {
    const owner = await insertUser();
    const editor = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner, "studio");
    await insertProjectMember(pid, editor, "editor");

    await projectMembersRepo.materializeBaselineViewer(pid, editor);

    expect(await projectMembersRepo.getRole(pid, editor)).toBe("editor");
    expect(await activeMemberCount(pid, editor)).toBe(1);
  });
});

describe("loadForViewer — access denial hides existence (404)", () => {
  it("rejects a studio member on a private project they are not a member of", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, member, "member");
    const pid = await insertProject(studioId, owner, "private");

    await expect(projectService.loadForViewer(pid, member)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await projectMembersRepo.getRole(pid, member)).toBeNull();
  });

  it("rejects a non-studio-member on a studio-visible project", async () => {
    const owner = await insertUser();
    const stranger = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner, "studio");

    await expect(projectService.loadForViewer(pid, stranger)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await projectMembersRepo.getRole(pid, stranger)).toBeNull();
  });
});
