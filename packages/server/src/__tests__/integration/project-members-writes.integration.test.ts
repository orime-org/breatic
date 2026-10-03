// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the project lifecycle writes into `project_members`, against a real
 * Postgres.
 *
 * This invariant had NO test at all. Measured rather than assumed: on
 * 2026-08-05 the owner insert in `duplicateProject` was changed from `owner`
 * to `viewer` and the whole suite stayed green, 476 integration tests and
 * every unit test: calling a function is not testing what it writes.
 *
 * Creation is covered in `project-access.integration.test.ts`, so it is not
 * repeated here. Duplication was unguarded, and it is guarded here.
 *
 * Both go through the repo directly rather than the service: the subject is
 * what lands in the table, and the service layer's authorisation is pinned by
 * its own suites.
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
import { initCore, db } from "@breatic/core";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

import * as projectRepo from "@server/modules/project/project.repo.js";

const PG_DRIVER_LOCAL = "project-members-writes-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Insert a fresh user.
 * @returns The new user's id.
 */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`pmw-${seq++}@example.com`}, true)
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Insert a fresh team studio.
 * @param createdByUserId - The creator, recorded on the studio row.
 * @returns The new studio's id.
 */
async function insertStudio(createdByUserId: string): Promise<string> {
  const slug = `pmw-studio-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${slug}, 'team', ${`Studio ${slug}`})
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Insert a project plus its owner row.
 * @param studioId - The owning studio.
 * @param ownerUserId - The user who gets the owner row.
 * @returns The new project's id.
 */
async function insertProject(
  studioId: string,
  ownerUserId: string,
): Promise<string> {
  const slug = `pmw-project-${seq++}`;
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

/**
 * Add a non-owner member to a project.
 * @param projectId - The project to add to.
 * @param userId - The member.
 * @param role - The role granted.
 * @param addedBy - Who granted it.
 */
async function addMember(
  projectId: string,
  userId: string,
  role: "editor" | "viewer",
  addedBy: string,
): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, ${role}, ${addedBy})
  `;
}

/** One row of `project_members`, as the assertions below read it. */
interface MemberRow {
  user_id: string;
  role: string;
  added_by: string | null;
  deleted_at: Date | null;
}

/**
 * Every member row of a project, live and soft-deleted alike.
 * @param projectId - The project to read.
 * @returns The rows, ordered by role so assertions are stable.
 */
async function allMemberRows(projectId: string): Promise<MemberRow[]> {
  return sql<MemberRow[]>`
    SELECT user_id, role, added_by, deleted_at
    FROM project_members
    WHERE project_id = ${projectId}
    ORDER BY role
  `;
}

/**
 * Copy a project through the repo the way the service does.
 *
 * `duplicateProject` takes the caller's transaction and an already-loaded
 * source (task #86): the copy lands in the source's studio and counts against
 * that studio's project ceiling, so the service has to hold the studio row and
 * check the count between reading the source and inserting the copy. These
 * cases are about the member rows, so they reproduce the shape without the
 * gate.
 * @param creatorUserId - Who makes the copy (becomes its owner).
 * @param sourceId - The project being copied.
 * @returns The new project entity.
 */
async function duplicateAsService(
  creatorUserId: string,
  sourceId: string,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const source = await projectRepo.getProjectById(sourceId, tx);
    if (!source) throw new Error(`source project ${sourceId} not found`);
    return projectRepo.duplicateProject(tx, creatorUserId, source);
  });
}

describe("duplicateProject — the copy belongs to whoever made it", () => {
  it("gives the duplicator an owner row, and nobody else a row at all", async () => {
    const owner = await insertUser();
    const editor = await insertUser();
    const studioId = await insertStudio(owner);
    const sourceId = await insertProject(studioId, owner);
    await addMember(sourceId, editor, "editor", owner);

    // The duplicator here is the source's editor, not its owner: a copy is a
    // fresh project, so the role that matters is the one the copy grants, not
    // the one its maker held on the original.
    const copy = await duplicateAsService(editor, sourceId);

    const rows = await allMemberRows(copy.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: editor,
      role: "owner",
      // No inviter: the creator was not added by anyone.
      added_by: null,
      deleted_at: null,
    });
  });

  it("leaves the source's membership untouched", async () => {
    const owner = await insertUser();
    const editor = await insertUser();
    const studioId = await insertStudio(owner);
    const sourceId = await insertProject(studioId, owner);
    await addMember(sourceId, editor, "editor", owner);

    await duplicateAsService(owner, sourceId);

    const rows = await allMemberRows(sourceId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.deleted_at === null)).toBe(true);
  });
});
