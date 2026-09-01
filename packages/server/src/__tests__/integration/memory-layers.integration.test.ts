// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Memory is two layers and both are the user's own (#148, A1-A4).
 *
 * Project memory used to be keyed by project alone, so everyone in a project
 * read and wrote one row. What one member's agent had summarised about their
 * own conversations was handed to the next member's system prompt, and the
 * next consolidation overwrote it.
 *
 * The read side and the write side are separate defects with separate causes,
 * and neither is caught by the compiler: the version read is a `where` clause
 * one `eq` short, and the update is raw SQL. The fixtures here give two users
 * a row apiece **with equal versions**, which is what makes a single-column
 * lookup actually pick the wrong one.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import * as memoryRepo from "@server/modules/memory/memory.repo.js";
import * as memoryService from "@server/modules/memory/memory.service.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";

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
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}, 'studio') RETURNING id
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
 * @param version - The optimistic-locking version to store.
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

/**
 * Read one project-memory row back, by owner.
 * @param userId - Whose memory to read.
 * @param projectId - Which project.
 * @returns The row's content and version.
 */
async function readProjectMemory(
  userId: string,
  projectId: string,
): Promise<{ content: string; version: number } | undefined> {
  const rows = await sql<{ content: string; version: number }[]>`
    SELECT content, version FROM project_memories
    WHERE user_id = ${userId} AND project_id = ${projectId}
  `;
  return rows[0];
}

describe("project memory belongs to one member, not to the project", () => {
  it("keeps one member's summary out of another member's context", async () => {
    const { userId: alice, projectId } = await seedProject();
    const carol = await seedMember(projectId);
    await seedProjectMemory(alice, projectId, "alice is working on a noir short", 4);
    await seedProjectMemory(carol, projectId, "carol is storyboarding a trailer", 4);

    const carolsContext = await memoryService.buildContext(carol, undefined, projectId);

    expect(carolsContext.projectMemory).toContain("carol");
    expect(carolsContext.projectMemory).not.toContain("alice");
  });

  it("writes a consolidation into the writer's own row", async () => {
    // Both members hold a row, so a conflict target that names the project
    // alone matches two of them and the write lands on whichever the database
    // returned first.
    const { userId: alice, projectId } = await seedProject();
    const carol = await seedMember(projectId);
    await seedProjectMemory(alice, projectId, "alice: noir short", 4);
    await seedProjectMemory(carol, projectId, "carol: trailer", 4);

    await memoryRepo.upsertProjectMemory(alice, projectId, "alice: noir short, act two");

    expect((await readProjectMemory(alice, projectId))?.content).toBe(
      "alice: noir short, act two",
    );
  });

  it("gives a member their first row while the other member already has one", async () => {
    // Only the other member has a row, so this is an insert. A conflict target
    // that names the project alone turns it into an update of the neighbour's
    // row instead. Giving the writer a row of their own would hide that: with
    // two rows present, either one coming back looks like a fit.
    const { userId: alice, projectId } = await seedProject();
    const carol = await seedMember(projectId);
    await seedProjectMemory(carol, projectId, "carol: trailer", 9);

    await memoryRepo.upsertProjectMemory(alice, projectId, "alice: act one");

    expect((await readProjectMemory(alice, projectId))?.content).toBe("alice: act one");
    expect(await readProjectMemory(carol, projectId)).toEqual({
      content: "carol: trailer",
      version: 9,
    });
  });

  it("leaves the other member's row untouched, content and version alike", async () => {
    const { userId: alice, projectId } = await seedProject();
    const carol = await seedMember(projectId);
    await seedProjectMemory(alice, projectId, "alice: noir short", 4);
    await seedProjectMemory(carol, projectId, "carol: trailer", 4);

    await memoryRepo.upsertProjectMemory(alice, projectId, "alice: noir short, act two");

    expect(await readProjectMemory(carol, projectId)).toEqual({
      content: "carol: trailer",
      version: 4,
    });
  });

  it("does not carry one project's memory into another", async () => {
    const alice = await seedProject();
    const elsewhere = await seedProject();
    // The same person in both projects: what separates the two is the project,
    // not the user.
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${elsewhere.projectId}, ${alice.userId}, 'editor', null)
    `;
    await seedProjectMemory(alice.userId, alice.projectId, "the noir short", 1);

    const context = await memoryService.buildContext(
      alice.userId,
      undefined,
      elsewhere.projectId,
    );

    expect(context.projectMemory).toBe("");
  });
});

describe("conversation memory stays in its own conversation", () => {
  it("reads the project layer but not another conversation's memory", async () => {
    const { userId, projectId } = await seedProject();
    const consolidated = await conversationRepo.createConversation(userId);
    await conversationRepo.setProjectId(consolidated.id, projectId);
    const fresh = await conversationRepo.createConversation(userId);
    await conversationRepo.setProjectId(fresh.id, projectId);

    await memoryRepo.upsertConversationMemory(consolidated.id, "we settled on a noir look");
    await seedProjectMemory(userId, projectId, "the project is a noir short", 1);

    const context = await memoryService.buildContext(userId, fresh.id, projectId);

    expect(context.projectMemory).toContain("noir short");
    expect(context.conversationMemory).toBe("");
  });
});

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
