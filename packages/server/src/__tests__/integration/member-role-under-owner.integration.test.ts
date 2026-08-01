// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The conditional role write a deferred decision lands through.
 *
 * `updateRoleUnderOwner` exists because a role-upgrade request is answered
 * days after it was filed, by which time either premise may be false: the
 * member may have been promoted or removed, and the decider may have handed
 * the project to somebody else. Both premises are checked inside the one
 * statement that writes, so there is nothing between check and write to race
 * with — and it takes no row lock, so it cannot join the deadlock the other
 * writers on this table already form.
 *
 * Needs a real Postgres: the whole subject is one statement's WHERE clause,
 * including a correlated EXISTS that no fake can stand in for.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing anything that pulls @breatic/core — the core
// barrel reaches agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM
// build uses bare relative imports Node's native ESM rejects.
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

// The setup file only puts the container URLs on `process.env`; handing them to
// core is each test's own job, since the setup file cannot import core.
initCore(process.env);

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "member-role-under-owner-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** An owner, a viewer, and a project the two share. */
async function seedProject(): Promise<{
  ownerId: string;
  viewerId: string;
  outsiderId: string;
  projectId: string;
}> {
  const tag = `mru-${seq++}`;
  const [owner, viewer, outsider] = await Promise.all([
    insertUser(`${tag}-owner`),
    insertUser(`${tag}-viewer`),
    insertUser(`${tag}-outsider`),
  ]);
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${owner}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${owner}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${owner}, 'owner', ${owner}),
           (${project!.id}, ${viewer}, 'viewer', ${owner})
  `;
  return {
    ownerId: owner,
    viewerId: viewer,
    outsiderId: outsider,
    projectId: project!.id,
  };
}

/**
 * Insert a user and return its id.
 * @param tag - Unique-ish fragment for the email.
 * @returns The new user's id.
 */
async function insertUser(tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  return row!.id;
}

/**
 * Read a member's current role, or null when they have no active row.
 * @param projectId - Project UUID.
 * @param userId - Member UUID.
 * @returns The role, or null.
 */
async function roleOf(
  projectId: string,
  userId: string,
): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM project_members
    WHERE project_id = ${projectId} AND user_id = ${userId}
      AND deleted_at IS NULL
  `;
  return rows[0]?.role ?? null;
}

describe("updateRoleUnderOwner", () => {
  it("promotes when both premises still hold", async () => {
    const { ownerId, viewerId, projectId } = await seedProject();

    const ok = await projectMembersRepo.updateRoleUnderOwner(
      projectId,
      viewerId,
      "viewer",
      "editor",
      ownerId,
    );

    expect(ok).toBe(true);
    expect(await roleOf(projectId, viewerId)).toBe("editor");
  });

  it("refuses when the member no longer holds the assumed role", async () => {
    // Somebody promoted them by another route while the request sat unanswered.
    // Re-applying a decision written against the old role would be writing over
    // a change nobody asked to undo.
    const { ownerId, viewerId, projectId } = await seedProject();
    await sql`
      UPDATE project_members SET role = 'editor'
      WHERE project_id = ${projectId} AND user_id = ${viewerId}
    `;

    const ok = await projectMembersRepo.updateRoleUnderOwner(
      projectId,
      viewerId,
      "viewer",
      "editor",
      ownerId,
    );

    expect(ok).toBe(false);
  });

  it("refuses when the member's row was soft-deleted", async () => {
    const { ownerId, viewerId, projectId } = await seedProject();
    await sql`
      UPDATE project_members SET deleted_at = now()
      WHERE project_id = ${projectId} AND user_id = ${viewerId}
    `;

    const ok = await projectMembersRepo.updateRoleUnderOwner(
      projectId,
      viewerId,
      "viewer",
      "editor",
      ownerId,
    );

    expect(ok).toBe(false);
    expect(await roleOf(projectId, viewerId)).toBeNull();
  });

  it("refuses when the decider is no longer the owner", async () => {
    // The exact shape of the bug this function exists for: a former owner
    // answering a request that was filed while they still held the project.
    const { ownerId, viewerId, projectId } = await seedProject();
    await sql`
      UPDATE project_members SET role = 'editor'
      WHERE project_id = ${projectId} AND user_id = ${ownerId}
    `;

    const ok = await projectMembersRepo.updateRoleUnderOwner(
      projectId,
      viewerId,
      "viewer",
      "editor",
      ownerId,
    );

    expect(ok).toBe(false);
    expect(await roleOf(projectId, viewerId)).toBe("viewer");
  });

  it("refuses a decider who was never a member of the project", async () => {
    const { viewerId, outsiderId, projectId } = await seedProject();

    const ok = await projectMembersRepo.updateRoleUnderOwner(
      projectId,
      viewerId,
      "viewer",
      "editor",
      outsiderId,
    );

    expect(ok).toBe(false);
    expect(await roleOf(projectId, viewerId)).toBe("viewer");
  });

  it("scopes the ownership check to this project, not to owning anything", async () => {
    // The EXISTS has to be correlated. An owner of some OTHER project must not
    // be able to decide here — an uncorrelated subquery would let them.
    const here = await seedProject();
    const elsewhere = await seedProject();

    const ok = await projectMembersRepo.updateRoleUnderOwner(
      here.projectId,
      here.viewerId,
      "viewer",
      "editor",
      elsewhere.ownerId,
    );

    expect(ok).toBe(false);
    expect(await roleOf(here.projectId, here.viewerId)).toBe("viewer");
  });
});
