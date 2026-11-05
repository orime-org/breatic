// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The project memory table is one row per member per project (#148).
 *
 * Project memory used to be keyed by project alone, so everyone in a project
 * read and wrote one row. Since #1363 the Agent's memory lives in
 * `agent_memories` and these rows were migrated into it word for word; the
 * table and its key stay, and these cases hold its shape.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { initCore } from "@breatic/core";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 8,
    prepare: false,
    connection: { application_name: "memory-layers-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A user, their studio, and one project they own. */
interface Seeded {
  userId: string;
  projectId: string;
}

/**
 * Seed an owner with a studio and a project they can write to.
 * @returns The freshly created user and project ids.
 */
async function seedProject(): Promise<Seeded> {
  const tag = `ml-${seq++}-${Date.now().toString(36)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  return { userId: user!.id, projectId: project!.id };
}

/**
 * Add a second member to an existing project.
 * @param projectId - The project to join.
 * @returns The new member's user id.
 */
async function seedMember(projectId: string): Promise<string> {
  const tag = `ml-m-${seq++}-${Date.now().toString(36)}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${user!.id}, 'editor', null)
  `;
  return user!.id;
}

/**
 * Write one project-memory row directly, bypassing the repository.
 * @param userId - Whose memory this is.
 * @param projectId - Which project it belongs to.
 * @param content - What it says.
 * @param version - What to put in the row's `version` column.
 */
async function seedProjectMemory(
  userId: string,
  projectId: string,
  content: string,
  version: number,
): Promise<void> {
  await sql`
    INSERT INTO project_memories (user_id, project_id, content, version)
    VALUES (${userId}, ${projectId}, ${content}, ${version})
  `;
}

describe("the project memory table after the migration", () => {
  it("clears the old rows before the column that would reject them", () => {
    // On CI's empty database both orders pass, so the order is asserted
    // against the SQL itself: `ADD COLUMN ... NOT NULL` on a table with rows
    // fails outright, and rows keyed by project alone have no user to name.
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../core/src/db/migrations/0068_project_memory_per_user.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    // Comments are stripped first: the note above the statements names both
    // of them, so matching the whole file finds the prose and reads the two
    // in whichever order the sentence happens to mention them.
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    const cleared = statements.search(/DELETE\s+FROM\s+"?project_memories"?/);
    const added = statements.indexOf("ADD COLUMN");
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(added).toBeGreaterThan(cleared);
  });

  it("holds one row per member per project, and only one", async () => {
    const { userId: alice, projectId } = await seedProject();
    const carol = await seedMember(projectId);

    await seedProjectMemory(alice, projectId, "alice", 1);
    await seedProjectMemory(carol, projectId, "carol", 1);

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM project_memories WHERE project_id = ${projectId}
    `;
    expect(rows[0]?.count).toBe("2");

    await expect(seedProjectMemory(alice, projectId, "alice again", 1)).rejects.toThrow();
  });
});
