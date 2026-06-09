// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio member-removal CASCADE primitives (slice 3) — the `projectMembersRepo`
 * methods that a studio kick fans out to, against a real Postgres. Kicking a
 * member from a studio must, in one tx: soft-delete every one of their
 * `project_members` rows in that studio's projects, and hand each project they
 * own to the studio admin. These are SQL-level (cross-table subquery, ON
 * CONFLICT owner revive, one-owner partial unique) so they are pinned here:
 *
 *   - softDeleteAllInStudioForUser — soft-deletes the user's active rows ONLY
 *     in that studio's projects (other studios / other users untouched).
 *   - listOwnedProjectsInStudio   — the projects they actively own in the
 *     studio (used BEFORE the soft-delete to know what to reassign).
 *   - materializeOwner            — insert / revive / promote the admin to
 *     owner; relies on the kicked owner's row already being soft-deleted in
 *     the same tx (else the one-owner partial unique would reject it).
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
import { initCore, projectMembersRepo } from "@breatic/core";

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
    connection: { application_name: "studio-member-cascade-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
async function insertUser(): Promise<string> {
  const email = `smc-${seq++}@example.com`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let studioSeq = 0;
async function insertStudio(createdByUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${`smc-studio-${studioSeq++}`}, 'team', 'Test Team Studio')
    RETURNING id
  `;
  return rows[0]!.id;
}

let projectSeq = 0;
async function insertProject(studioId: string, createdByUserId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${createdByUserId}, ${`smc-proj-${projectSeq++}`}, 'Test Project')
    RETURNING id
  `;
  return rows[0]!.id;
}

async function insertProjectMemberRaw(
  projectId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (${projectId}, ${userId}, ${role})
  `;
}

async function rawProjectRole(projectId: string, userId: string): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM project_members WHERE project_id = ${projectId} AND user_id = ${userId}
  `;
  return rows[0]?.role ?? null;
}

async function rawProjectDeletedAt(projectId: string, userId: string): Promise<Date | null> {
  const rows = await sql<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM project_members WHERE project_id = ${projectId} AND user_id = ${userId}
  `;
  return rows[0]?.deleted_at ?? null;
}

describe("softDeleteAllInStudioForUser — clear the kicked member's project access", () => {
  it("soft-deletes the user's active rows ONLY within that studio's projects", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(admin);
    const otherStudio = await insertStudio(admin);
    const projA = await insertProject(studio, admin);
    const projB = await insertProject(studio, admin);
    const projOther = await insertProject(otherStudio, admin);
    await insertProjectMemberRaw(projA, member, "editor");
    await insertProjectMemberRaw(projB, member, "viewer");
    await insertProjectMemberRaw(projOther, member, "viewer"); // different studio — must stay

    const count = await projectMembersRepo.softDeleteAllInStudioForUser(studio, member);

    expect(count).toBe(2);
    expect(await projectMembersRepo.getRole(projA, member)).toBeNull();
    expect(await projectMembersRepo.getRole(projB, member)).toBeNull();
    expect(await projectMembersRepo.getRole(projOther, member)).toBe("viewer"); // untouched
    // soft delete only — rows physically remain
    expect(await rawProjectRole(projA, member)).toBe("editor");
  });

  it("does not touch other members' rows and returns 0 when the user has no rows", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudio(admin);
    const proj = await insertProject(studio, admin);
    await insertProjectMemberRaw(proj, stranger, "viewer");

    const count = await projectMembersRepo.softDeleteAllInStudioForUser(studio, member);

    expect(count).toBe(0);
    expect(await projectMembersRepo.getRole(proj, stranger)).toBe("viewer"); // untouched
  });
});

describe("listOwnedProjectsInStudio — projects the kicked member owns", () => {
  it("returns only the projects the user actively OWNS in that studio", async () => {
    const member = await insertUser();
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const otherStudio = await insertStudio(member);
    const owned = await insertProject(studio, member);
    const ownedToo = await insertProject(studio, member);
    const justViewer = await insertProject(studio, admin);
    const ownedElsewhere = await insertProject(otherStudio, member);
    await insertProjectMemberRaw(owned, member, "owner");
    await insertProjectMemberRaw(ownedToo, member, "owner");
    await insertProjectMemberRaw(justViewer, member, "viewer"); // not owner — excluded
    await insertProjectMemberRaw(ownedElsewhere, member, "owner"); // other studio — excluded

    const ids = await projectMembersRepo.listOwnedProjectsInStudio(studio, member);

    expect([...ids].sort()).toEqual([owned, ownedToo].sort());
  });
});

describe("materializeOwner — hand a project to the studio admin", () => {
  it("inserts an active owner row when the admin has no row on the project", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const proj = await insertProject(studio, admin);

    await projectMembersRepo.materializeOwner(proj, admin);

    expect(await projectMembersRepo.getRole(proj, admin)).toBe("owner");
  });

  it("promotes the admin to owner when they were a viewer on the project", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const proj = await insertProject(studio, admin);
    await insertProjectMemberRaw(proj, admin, "viewer");

    await projectMembersRepo.materializeOwner(proj, admin);

    expect(await projectMembersRepo.getRole(proj, admin)).toBe("owner");
  });

  it("revives a soft-deleted admin row as owner", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const proj = await insertProject(studio, admin);
    await insertProjectMemberRaw(proj, admin, "viewer");
    await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ${proj} AND user_id = ${admin}`;

    await projectMembersRepo.materializeOwner(proj, admin);

    expect(await projectMembersRepo.getRole(proj, admin)).toBe("owner");
    expect(await rawProjectDeletedAt(proj, admin)).toBeNull();
  });

  it("rejects a second active owner while the original owner is still active (one-owner guard)", async () => {
    const owner = await insertUser();
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const proj = await insertProject(studio, owner);
    await insertProjectMemberRaw(proj, owner, "owner");

    // The kicked owner's row must be soft-deleted FIRST in the real flow;
    // without that, promoting a second owner hits the one-owner partial unique.
    await expect(projectMembersRepo.materializeOwner(proj, admin)).rejects.toThrow();
  });
});
