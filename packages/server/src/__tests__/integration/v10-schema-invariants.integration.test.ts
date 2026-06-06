// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * v10 schema invariants — partial unique indexes round-trip.
 *
 * Asserts the two PG-level invariants that no application code can
 * substitute for:
 *
 *   1. `studios_owner_personal_idx`
 *      Each user has at most one active personal studio. Inserting a
 *      second active `type='personal'` row for the same
 *      `created_by_user_id` is rejected.
 *
 *   2. `project_members_one_owner_per_project`
 *      Each project has at most one active row with `role='owner'`.
 *      A second active owner insert is rejected; soft-deleting the
 *      first row makes the next insert succeed (revival path).
 *
 * Runs against a real PostgreSQL container started by global-setup.ts.
 * Skips testcontainers' application-bootstrap path entirely — this
 * test owns its own postgres-js client to keep the round-trip narrow.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import postgres from "postgres";

const PG_DRIVER_LOCAL = "test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = inject("DATABASE_URL");
  sql = postgres(url, { max: 2, prepare: false, connection: { application_name: PG_DRIVER_LOCAL } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** Generate a random RFC 4122 v4 UUID via PG to avoid loading uuid dep here. */
async function uuid(): Promise<string> {
  const rows = await sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
  return rows[0]!.id;
}

async function insertUser(email: string): Promise<string> {
  // Balance lives in `credit_balances` since PR3 (migration 0020) — the
  // `users.credits` column no longer exists, so the seed inserts neither.
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return row!.id;
}

let studioSlugSeq = 0;
async function insertStudio(createdByUserId: string, name: string): Promise<string> {
  // slug is globally unique (studios_slug_idx) — give each seed studio a
  // distinct slug so these tests exercise ONLY the personal-per-user
  // index, never a slug collision.
  const slug = `v10-studio-${studioSlugSeq++}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${slug}, 'personal', ${name})
    RETURNING id
  `;
  return row!.id;
}

async function insertProject(
  studioId: string,
  creatorUserId: string,
  name: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name)
    VALUES (${studioId}, ${creatorUserId}, ${name})
    RETURNING id
  `;
  return row!.id;
}

describe("studios_owner_personal_idx — one active personal studio per user", () => {
  it("first insert succeeds; second active insert is rejected", async () => {
    const userId = await insertUser(`u-${(await uuid()).slice(0, 8)}@x.com`);

    await insertStudio(userId, "first");

    let rejected = false;
    try {
      await insertStudio(userId, "second");
    } catch (err) {
      rejected = true;
      expect(String(err)).toMatch(/studios_owner_personal_idx|duplicate key/);
    }
    expect(rejected).toBe(true);
  });

  it("soft-deleting the first studio frees the index for a new insert", async () => {
    const userId = await insertUser(`u-${(await uuid()).slice(0, 8)}@x.com`);
    const firstId = await insertStudio(userId, "first");

    await sql`UPDATE studios SET deleted_at = now() WHERE id = ${firstId}`;
    await expect(insertStudio(userId, "revived")).resolves.toEqual(expect.any(String));
  });
});

describe("project_members_one_owner_per_project", () => {
  it("rejects a second active owner row", async () => {
    const owner = await insertUser(`o-${(await uuid()).slice(0, 8)}@x.com`);
    const stranger = await insertUser(`s-${(await uuid()).slice(0, 8)}@x.com`);
    const studioId = await insertStudio(owner, "studio");
    const projectId = await insertProject(studioId, owner, "project");

    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${owner}, 'owner', NULL)
    `;

    let rejected = false;
    try {
      await sql`
        INSERT INTO project_members (project_id, user_id, role, added_by)
        VALUES (${projectId}, ${stranger}, 'owner', ${owner})
      `;
    } catch (err) {
      rejected = true;
      expect(String(err)).toMatch(/project_members_one_owner_per_project|duplicate key/);
    }
    expect(rejected).toBe(true);
  });

  it("non-owner roles can coexist freely (the index only constrains owner)", async () => {
    const owner = await insertUser(`o-${(await uuid()).slice(0, 8)}@x.com`);
    const m1 = await insertUser(`m-${(await uuid()).slice(0, 8)}@x.com`);
    const m2 = await insertUser(`m-${(await uuid()).slice(0, 8)}@x.com`);
    const studioId = await insertStudio(owner, "studio");
    const projectId = await insertProject(studioId, owner, "project");

    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${owner}, 'owner', NULL),
             (${projectId}, ${m1},    'edit',  ${owner}),
             (${projectId}, ${m2},    'view',  ${owner})
    `;

    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM project_members WHERE project_id = ${projectId}
    `;
    expect(rows[0]!.count).toBe("3");
  });

  it("soft-deleting the active owner row revives capacity for a new owner", async () => {
    const oldOwner = await insertUser(`o-${(await uuid()).slice(0, 8)}@x.com`);
    const newOwner = await insertUser(`n-${(await uuid()).slice(0, 8)}@x.com`);
    const studioId = await insertStudio(oldOwner, "studio");
    const projectId = await insertProject(studioId, oldOwner, "project");

    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${oldOwner}, 'owner', NULL)
    `;

    // While the owner row is active, a second insert is rejected.
    await expect(
      sql`
        INSERT INTO project_members (project_id, user_id, role, added_by)
        VALUES (${projectId}, ${newOwner}, 'owner', ${oldOwner})
      `,
    ).rejects.toThrow();

    // Soft-delete the active owner row; the partial unique index now sees zero
    // active owners and admits a fresh one.
    await sql`
      UPDATE project_members
         SET deleted_at = now()
       WHERE project_id = ${projectId} AND user_id = ${oldOwner}
    `;

    await expect(
      sql`
        INSERT INTO project_members (project_id, user_id, role, added_by)
        VALUES (${projectId}, ${newOwner}, 'owner', ${oldOwner})
      `,
    ).resolves.toBeDefined();
  });
});

describe("tasks.space_id NOT NULL — v10 multi-doc routing", () => {
  it("rejects task insert without space_id (worker can't compute canvas-{sid} doc name)", async () => {
    const userId = await insertUser(`u-${(await uuid()).slice(0, 8)}@x.com`);
    const studioId = await insertStudio(userId, "studio");
    const projectId = await insertProject(studioId, userId, "project");

    // The PG-level `space_id NOT NULL` constraint backs the v10
    // promise that worker.handlers can always compute the
    // canvas-{spaceId} doc to write back to. A task row without
    // space_id would force the worker into a "no docName" branch
    // that should never exist by design.
    await expect(
      sql`
        INSERT INTO tasks (user_id, project_id, task_type, mode, params, source)
        VALUES (${userId}, ${projectId}, 'image', 'append', '{}'::jsonb, 'mini_tool')
      `,
    ).rejects.toThrow(/null value in column "space_id"/);
  });

  it("accepts task insert with space_id present", async () => {
    const userId = await insertUser(`u-${(await uuid()).slice(0, 8)}@x.com`);
    const studioId = await insertStudio(userId, "studio");
    const projectId = await insertProject(studioId, userId, "project");
    const spaceId = await uuid();

    await expect(
      sql`
        INSERT INTO tasks (user_id, project_id, space_id, task_type, mode, params, source)
        VALUES (${userId}, ${projectId}, ${spaceId}, 'image', 'append', '{}'::jsonb, 'mini_tool')
      `,
    ).resolves.toBeDefined();
  });
});
