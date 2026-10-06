// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project access critical-path invariants — `projectService.create`,
 * `projectService.listByStudioForViewer` and `projectService.loadForViewer`
 * against a real Postgres.
 *
 * Access is a CLAUDE.md critical path (鉴权 + 数据完整性): every studio member
 * sees every project, only a project member may enter one, and opening a
 * project never writes a member row.
 *
 * Seeding uses a narrow raw `postgres` client; the assertions call the real
 * service (core's env-bound `db`, pointed at the testcontainer via the
 * injected config) and the real `loadStudioRole` (domain).
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
import { ForbiddenError, initCore, NotFoundError, projectMembersRepo } from "@breatic/core";
import * as projectService from "@server/modules/project/project.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "project-access-test-driver";

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
  const slug = `pv-project-${projSeq++}`;
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

/**
 * Read back the first space's type (B.2) that `create` carried through.
 * @param projectId - The project to read.
 * @returns The persisted value.
 * @throws {Error} if the project row is gone.
 */
async function storedProject(projectId: string): Promise<{ spaceType: string }> {
  const rows = await sql<{ space_type: string }[]>`
    SELECT initial_space_type AS space_type FROM projects WHERE id = ${projectId}
  `;
  const row = rows[0];
  if (row === undefined) throw new Error(`no project ${projectId}`);
  return { spaceType: row.space_type };
}

describe("projectService.create — studio admin/maintainer gate (critical path 鉴权 + §0.2)", () => {
  it("admin creates in the target studio: project lands there + one owner row for the caller", async () => {
    const admin = await insertUser();
    const studioId = await insertStudio(admin);
    await insertStudioMember(studioId, admin, "admin");

    const project = await projectService.create(
      admin,
      studioId,
      "Admin Project",
      "admin-gate-project",
      "canvas",
    );

    expect(project.studioId).toBe(studioId);
    expect(project.createdByUserId).toBe(admin);
    expect(await ownerCount(project.id)).toBe(1);
    expect(await activeMemberCount(project.id, admin)).toBe(1);
    const stored = await storedProject(project.id);
    expect(stored.spaceType).toBe("canvas");
  });

  it("a maintainer may create (admin + maintainer can spend shared studio credits)", async () => {
    const admin = await insertUser();
    const maintainer = await insertUser();
    const studioId = await insertStudio(admin);
    await insertStudioMember(studioId, admin, "admin");
    await insertStudioMember(studioId, maintainer, "maintainer");

    const project = await projectService.create(
      maintainer,
      studioId,
      "Creator Project",
      "creator-gate-project",
      "document",
    );

    expect(project.studioId).toBe(studioId);
    expect(project.createdByUserId).toBe(maintainer);
    // A non-default type persists end-to-end (B.2 plumbing — even though
    // document is disabled in the picker, the column stores any SpaceType).
    expect((await storedProject(project.id)).spaceType).toBe("document");
  });

  it("a plain guest is rejected (ForbiddenError) — cannot burn shared studio credits", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studioId = await insertStudio(admin);
    await insertStudioMember(studioId, admin, "admin");
    await insertStudioMember(studioId, member, "guest");

    await expect(
      projectService.create(member, studioId, "Member Project", "member-gate-project", "canvas"),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("a non-member (no studio_members row) is rejected (ForbiddenError)", async () => {
    const admin = await insertUser();
    const stranger = await insertUser();
    const studioId = await insertStudio(admin);
    await insertStudioMember(studioId, admin, "admin");

    await expect(
      projectService.create(stranger, studioId, "Stranger Project", "stranger-gate-project", "canvas"),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});

describe("listByStudioForViewer — every studio member sees every project (A1)", () => {
  it("a guest sees projects they are not on, with a null role; a non-member sees none", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const stranger = await insertUser();
    const studioId = await insertStudio(admin);
    await insertStudioMember(studioId, admin, "admin");
    await insertStudioMember(studioId, member, "guest");

    const pAdmin = await insertProject(studioId, admin);
    const pMember = await insertProject(studioId, member);

    const asMember = await projectService.listByStudioForViewer(studioId, member, { archived: false });
    expect(asMember.find((p) => p.id === pAdmin)!.myRole).toBeNull();
    expect(asMember.find((p) => p.id === pMember)!.myRole).toBe("owner");

    const asAdmin = await projectService.listByStudioForViewer(studioId, admin, { archived: false });
    expect(asAdmin.find((p) => p.id === pMember)!.myRole).toBeNull();

    expect(await projectService.listByStudioForViewer(studioId, stranger, { archived: false })).toEqual([]);
  });

  it("carries slug and studio on each summary row", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner);

    const list = await projectService.listByStudioForViewer(studioId, owner, { archived: false });
    const row = list.find((p) => p.id === pid)!;
    expect(row.slug).toMatch(/^pv-project-/);
    expect(row.studioId).toBe(studioId);
  });

  it("orders projects newest-CREATED first (catalog order, not last-activity)", async () => {
    const owner = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pOld = await insertProject(studioId, owner);
    const pMid = await insertProject(studioId, owner);
    const pNew = await insertProject(studioId, owner);
    // Insert defaults created_at to now() (not orderable across fast inserts);
    // stamp explicit creation times so the DESC order is deterministic.
    await sql`UPDATE projects SET created_at = '2026-01-01T00:00:00Z' WHERE id = ${pOld}`;
    await sql`UPDATE projects SET created_at = '2026-02-01T00:00:00Z' WHERE id = ${pMid}`;
    await sql`UPDATE projects SET created_at = '2026-03-01T00:00:00Z' WHERE id = ${pNew}`;

    const ids = (await projectService.listByStudioForViewer(studioId, owner, { archived: false })).map(
      (p) => p.id,
    );
    expect(ids.indexOf(pNew)).toBeLessThan(ids.indexOf(pMid));
    expect(ids.indexOf(pMid)).toBeLessThan(ids.indexOf(pOld));
  });
});

describe("loadForViewer — only members enter, and opening writes nothing (A4 A11)", () => {
  it("a studio member who is not on the project gets 403 and no member row, even on repeated tries", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, member, "guest");
    const pid = await insertProject(studioId, owner);

    const results = await Promise.allSettled([
      projectService.loadForViewer(pid, member),
      projectService.loadForViewer(pid, member),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenError);
    }
    expect(await activeMemberCount(pid, member)).toBe(0);
    expect(await ownerCount(pid)).toBe(1);
  });

  it("a removed member stays out: their soft-deleted row is not revived by opening", async () => {
    const owner = await insertUser();
    const member = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    await insertStudioMember(studioId, member, "guest");
    const pid = await insertProject(studioId, owner);
    await insertProjectMember(pid, member, "viewer", true);

    await expect(projectService.loadForViewer(pid, member)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await projectMembersRepo.getRole(pid, member)).toBeNull();
  });

  it("someone outside the studio gets 404, so existence is not leaked", async () => {
    const owner = await insertUser();
    const stranger = await insertUser();
    const studioId = await insertStudio(owner);
    await insertStudioMember(studioId, owner, "admin");
    const pid = await insertProject(studioId, owner);

    await expect(projectService.loadForViewer(pid, stranger)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await projectMembersRepo.getRole(pid, stranger)).toBeNull();
  });
});
