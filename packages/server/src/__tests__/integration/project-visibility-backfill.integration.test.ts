// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What migration 0049 does to the rows it finds.
 *
 * Projects lost the visibility concept on 2026-08-07: nobody chooses a value
 * any more and every new project takes the column default. Rows created before
 * that could say `private`, and the filter layers still read the column — so
 * a leftover `private` row would stay hidden from most of its studio with no
 * way for anyone to change it. 0049 sweeps them.
 *
 * WHAT THIS SUITE PROVES, and what it does not.
 *
 * It reads the migration's own SQL text and runs it, so what is under test is
 * the STATEMENT: that it lifts `private` rows and leaves `studio` rows alone.
 * It does NOT prove the migration will be executed — drizzle's migrator reads
 * `meta/_journal.json` and never opens a `.sql` that is not listed there, so an
 * unregistered file is silently skipped. That half is covered by the journal
 * entry itself plus repo-lint's migration-style check, not by any test.
 *
 * Nor can it be written the obvious way. `global-setup.ts` migrates the
 * container before any test module loads, and drizzle's migrate() no-ops on a
 * second call with no way to stop at an earlier version — so a row inserted by
 * a test is always inserted after 0049 has already run. Reading the file is the
 * only way to exercise the statement at all.
 *
 * Everything happens inside a transaction that is rolled back. That is not
 * tidiness: nine integration suites insert `private` projects on purpose, one of
 * them (`project-visibility-materialize`) exists to test the filter that hides
 * them. A committed sweep here would quietly lift their fixtures out from under
 * them.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing anything that reaches @breatic/core — the core
// barrel pulls agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build
// uses bare relative imports Node's native ESM rejects. This suite calls no ai
// function.
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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const PG_DRIVER_LOCAL = "visibility-backfill-test-driver";

/** The migration under test, resolved from this file rather than the cwd. */
const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../core/src/db/migrations/0049_projects_visibility_all_studio.sql",
);

/** Drizzle's statement separator, stripped before the SQL is executed. */
const BREAKPOINT = /-->\s*statement-breakpoint/g;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** Thrown to roll the transaction back once the observations are taken. */
const ROLLBACK = Symbol("rollback");

/** What the two seeded rows said after the migration statement ran. */
interface Observed {
  /** Visibility of the row seeded as `private`. */
  readonly seededPrivate: string;
  /** Visibility of the row seeded as `studio`. */
  readonly seededStudio: string;
  /** How many rows the statement touched, across the whole table. */
  readonly touched: number;
}

/**
 * Seed one private and one studio-visible project, run the migration's SQL,
 * and report what the two rows say afterwards — then roll everything back.
 * @returns What the two seeded rows said, and how many rows were touched.
 * @throws {Error} if the migration file cannot be read or its SQL fails.
 */
async function runMigrationOnSeededRows(): Promise<Observed> {
  const statement = (await readFile(MIGRATION, "utf8"))
    .replace(BREAKPOINT, "")
    .trim();

  let observed: Observed | undefined;
  await sql
    .begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (email, email_verified)
        VALUES ('vis-backfill@example.com', true) RETURNING id
      `;
      const [studio] = await tx<{ id: string }[]>`
        INSERT INTO studios (created_by_user_id, slug, type, name)
        VALUES (${user!.id}, 'vis-backfill-studio', 'team', 'Backfill') RETURNING id
      `;
      const [hidden] = await tx<{ id: string }[]>`
        INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
        VALUES (${studio!.id}, ${user!.id}, 'Hidden', 'vis-hidden', 'private')
        RETURNING id
      `;
      const [open] = await tx<{ id: string }[]>`
        INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
        VALUES (${studio!.id}, ${user!.id}, 'Open', 'vis-open', 'studio')
        RETURNING id
      `;

      const result = await tx.unsafe(statement);

      const [after] = await tx<{ hidden: string; open: string }[]>`
        SELECT
          (SELECT visibility FROM projects WHERE id = ${hidden!.id}) AS hidden,
          (SELECT visibility FROM projects WHERE id = ${open!.id}) AS open
      `;
      observed = {
        seededPrivate: after!.hidden,
        seededStudio: after!.open,
        touched: result.count,
      };
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });

  if (observed === undefined) {
    throw new Error("the transaction produced no observation");
  }
  return observed;
}

describe("migration 0049 — every project becomes studio-visible", () => {
  it("lifts a private project and leaves a studio-visible one alone", async () => {
    const observed = await runMigrationOnSeededRows();
    expect(observed.seededPrivate).toBe("studio");
    expect(observed.seededStudio).toBe("studio");
  });

  it("touches only the rows that were not already studio-visible", async () => {
    // The container is migrated before any test runs, so the only non-studio
    // row in the table is the one seeded above. A statement without the WHERE
    // clause would rewrite every project in the table and show up here as a
    // count above one — that is the point of asserting on it rather than just
    // on the two rows, which would pass either way.
    const observed = await runMigrationOnSeededRows();
    expect(observed.touched).toBe(1);
  });
});
