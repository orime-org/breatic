// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Migration 0107 drops what the retired skill mechanism left in the database
 * (inner#1310): the `custom_skills` and `skill_installs` tables and the
 * `tasks.skill_name` and `tasks.resolved_skills` columns. No code has read or
 * written them since generation templates replaced skills.
 *
 * Some databases had these objects dropped by hand before the migration
 * existed, so 0107 must also run cleanly where they are already gone. The
 * suite re-runs the migration file on the fully migrated database, where
 * every object is already gone, to cover that case.
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const PG_DRIVER_LOCAL = "skill-tables-retired-test-driver";

const MIGRATION_PATH = new URL(
  "../../../../core/src/db/migrations/0107_drop_skill_tables.sql",
  import.meta.url,
);

let sql: postgres.Sql;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, connection: { application_name: PG_DRIVER_LOCAL } });
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/**
 * The column names of a table, as the database reports them.
 * @param table - Table name in the public schema
 * @returns The column names; empty when the table does not exist
 */
async function columnNamesOf(table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.map((row) => row.column_name);
}

describe("skill tables retired (0107)", () => {
  it("drops custom_skills and skill_installs", async () => {
    expect(await columnNamesOf("custom_skills")).toEqual([]);
    expect(await columnNamesOf("skill_installs")).toEqual([]);
  });

  it("drops skill_name and resolved_skills from tasks", async () => {
    const columns = await columnNamesOf("tasks");
    expect(columns.length).toBeGreaterThan(0);
    expect(columns).not.toContain("skill_name");
    expect(columns).not.toContain("resolved_skills");
  });

  it("runs again without error where the objects are already gone", async () => {
    const statements = readFileSync(MIGRATION_PATH, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await expect(sql.unsafe(statement)).resolves.toBeDefined();
    }
  });
});
