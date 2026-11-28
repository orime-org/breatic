// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * collab's product-database writes run under its own account (inner#2043).
 *
 * In this suite core's `db` logs in as `breatic_collab_test`, as collab does
 * in production with `COLLAB_DATABASE_URL`. Every write collab makes goes
 * through one of five core functions; each one runs here under that account,
 * including the conflict branch of `touchProjectEdit` and the restore swap.
 * A second login with the same role, `breatic_collab_probe`, writes outside
 * the list on purpose and is refused. Fixtures are written with the admin
 * account.
 */

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  accountActivityRepo,
  createTestDb,
  initCore,
  projectActivitiesRepo,
  projectEditsRepo,
  projectsRepo,
  rawPg,
} from "@breatic/core";

type Client = ReturnType<typeof createTestDb>["client"];
let admin!: Client;
let probe!: Client;

interface Fixture {
  userId: string;
  projectId: string;
}

/**
 * A user, a personal studio and a Project, written with the admin account.
 * @returns Their ids.
 * @throws {Error} When a write fails.
 */
async function seed(): Promise<Fixture> {
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const [user] = await admin<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`own-${tag}@example.test`}, true) RETURNING id`;
  const [studio] = await admin<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`own-s-${tag}`}, 'personal', 'Own') RETURNING id`;
  const [project] = await admin<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studio!.id}, ${user!.id}, ${`own-p-${tag}`}, 'Own') RETURNING id`;
  return { userId: user!.id, projectId: project!.id };
}

beforeAll(() => {
  initCore(process.env);
  admin = createTestDb(inject("DATABASE_URL"), 2).client;
  probe = createTestDb(inject("COLLAB_PROBE_DATABASE_URL"), 1).client;
});

afterAll(async () => {
  await Promise.allSettled([admin.end({ timeout: 1 }), probe.end({ timeout: 1 })]);
});

describe("collab's connection", () => {
  it("logs in as breatic_collab_test", async () => {
    const [row] = await rawPg<{ u: string }[]>`SELECT current_user AS u`;
    expect(row).toEqual({ u: "breatic_collab_test" });
  });
});

describe("collab's writes under its own account", () => {
  it("appends a project activity row", async () => {
    const f = await seed();
    const id = await projectActivitiesRepo.insert({
      projectId: f.projectId, actorUserId: f.userId, type: "space:created", spaceId: randomUUID(), payload: {},
    });
    const rows = await admin`SELECT project_id FROM project_activities WHERE id = ${id}`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ project_id: f.projectId }]);
  });

  it("consumes a deleted Space's snapshot and appends the restore row", async () => {
    const f = await seed();
    const spaceId = randomUUID();
    const [deleted] = await admin<{ id: string }[]>`
      INSERT INTO project_activities (project_id, actor_user_id, type, space_id, payload)
      VALUES (${f.projectId}, ${f.userId}, 'space:deleted', ${spaceId}, jsonb_build_object('spaceName', 'S'))
      RETURNING id`;
    const won = await projectActivitiesRepo.consumeRestoreAndAppend(deleted!.id, {
      projectId: f.projectId, actorUserId: f.userId, type: "space:restored", spaceId, payload: {},
    });
    expect(won).toBe(true);
    const rows = await admin<{ type: string; restored: boolean }[]>`
      SELECT type, restored FROM project_activities WHERE project_id = ${f.projectId} ORDER BY created_at`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { type: "space:deleted", restored: true },
      { type: "space:restored", restored: false },
    ]);
  });

  it("records an account activity event", async () => {
    const f = await seed();
    const recorded = await accountActivityRepo.recordActivity({ userId: f.userId, projectId: f.projectId, kind: "project_edit" });
    expect(recorded.inserted).toBe(true);
  });

  it("records a Project edit, then moves its time on the next edit", async () => {
    const f = await seed();
    await projectEditsRepo.touchProjectEdit(f.projectId);
    const [first] = await admin<{ t: string }[]>`SELECT last_edited_at::text AS t FROM project_edits WHERE project_id = ${f.projectId}`;
    await projectEditsRepo.touchProjectEdit(f.projectId);
    const [second] = await admin<{ t: string }[]>`SELECT last_edited_at::text AS t FROM project_edits WHERE project_id = ${f.projectId}`;
    expect(second!.t > first!.t).toBe(true);
  });

  it("marks a copied Project completed without touching any other column", async () => {
    const f = await seed();
    const [before] = await admin<{ u: string }[]>`SELECT updated_at::text AS u FROM projects WHERE id = ${f.projectId}`;
    await projectsRepo.markDuplicateCompleted(f.projectId);
    const [after] = await admin<{ done: boolean; u: string }[]>`
      SELECT duplicate_completed_at IS NOT NULL AS done, updated_at::text AS u FROM projects WHERE id = ${f.projectId}`;
    expect({ ...after }).toEqual({ done: true, u: before!.u });
  });
});

describe("writes outside the list", () => {
  const attempts: [string, (sql: Client, f: Fixture) => Promise<unknown>][] = [
    ["inserting a user", (sql) => sql`INSERT INTO users (email) VALUES (${`probe-${randomUUID()}@example.test`})`],
    ["updating a studio asset", (sql) => sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${randomUUID()}`],
    ["inserting an analytics milestone", (sql) => sql`INSERT INTO analytics_milestones DEFAULT VALUES`],
    ["inserting an ad conversion upload", (sql) => sql`INSERT INTO ads_conversion_uploads DEFAULT VALUES`],
    ["renaming a Project", (sql, f) => sql`UPDATE projects SET name = 'renamed' WHERE id = ${f.projectId}`],
    ["deleting a project activity row", (sql, f) => sql`DELETE FROM project_activities WHERE project_id = ${f.projectId}`],
  ];
  for (const [label, attempt] of attempts) {
    it(`refuses ${label}`, async () => {
      const f = await seed();
      await expect(attempt(probe, f)).rejects.toMatchObject({ code: "42501" });
    });
  }
});
