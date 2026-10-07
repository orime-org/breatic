// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `touchProjectEdit` against a real Postgres: one row per project, the first
 * call inserts it, later calls move `last_edited_at` forward, and a call made
 * inside a transaction is undone with that transaction.
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
import { db, initCore, projectEditsRepo } from "@breatic/core";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "project-edits-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Insert a user, a studio and one project in it.
 * @returns The project id.
 */
async function insertProject(): Promise<string> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`pe-${n}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`pe-studio-${n}`}, 'team', 'Studio') RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, 'Project', ${`pe-project-${n}`}) RETURNING id
  `;
  return project!.id;
}

/**
 * Read a project's edit row.
 * @param projectId - The project.
 * @returns Its `last_edited_at` as Postgres text, and how many rows it has.
 */
async function readEdit(projectId: string): Promise<{ at: string | null; rows: number }> {
  const rows = await sql<{ at: string }[]>`
    SELECT last_edited_at::text AS at FROM project_edits WHERE project_id = ${projectId}
  `;
  return { at: rows[0]?.at ?? null, rows: rows.length };
}

describe("touchProjectEdit", () => {
  it("inserts the project's row on the first call", async () => {
    const projectId = await insertProject();

    await projectEditsRepo.touchProjectEdit(projectId);

    const edit = await readEdit(projectId);
    expect(edit.rows).toBe(1);
    expect(edit.at).not.toBeNull();
  });

  it("moves last_edited_at forward on a later call and keeps one row", async () => {
    const projectId = await insertProject();
    await projectEditsRepo.touchProjectEdit(projectId);
    await sql`UPDATE project_edits SET last_edited_at = now() - interval '1 day' WHERE project_id = ${projectId}`;
    const before = await readEdit(projectId);

    await projectEditsRepo.touchProjectEdit(projectId);

    const after = await readEdit(projectId);
    expect(after.rows).toBe(1);
    const [{ moved }] = await sql<{ moved: boolean }[]>`
      SELECT ${after.at}::timestamptz > ${before.at}::timestamptz AS moved
    `;
    expect(moved).toBe(true);
  });

  it("is undone with the transaction it was written in", async () => {
    const projectId = await insertProject();

    await expect(
      db.transaction(async (tx) => {
        await projectEditsRepo.touchProjectEdit(projectId, tx);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");

    expect((await readEdit(projectId)).rows).toBe(0);
  });
});
