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
 * unregistered file is silently skipped.
 *
 * NOTHING catches that half — not this suite, not CI, not a human running the
 * migration. drizzle's `readMigrationFiles` loops over `journal.entries` and
 * never enumerates the folder, so a `.sql` nobody registered is never opened
 * and `pnpm db:migrate` exits 0 having skipped it. repo-lint's migration-style
 * check is no help either: it finds folders through the journal but then lints
 * every `.sql` in them, so the orphan reads clean. The only thing standing
 * between a hand-written migration and silently never running is the author
 * remembering to add the journal entry.
 *
 * (Running the migration DOES catch the mirror failure — an entry whose file
 * is missing throws `No file ... found`. That is a different mistake.)
 *
 * Nor can it be written the obvious way. `global-setup.ts` migrates the
 * container before any test module loads, and drizzle's migrate() no-ops on a
 * second call with no way to stop at an earlier version — so a row inserted by
 * a test is always inserted after 0049 has already run. Reading the file is the
 * only way to exercise the statement at all.
 *
 * WHY IT RUNS AGAINST A COPY OF THE TABLE rather than the real one. The suites
 * share one database and none of them cleans up: nine insert `private`
 * projects on purpose, and one exists to test the filter that hides them. They
 * run one at a time (`singleFork: true`), so nothing races — but by the time
 * this file runs, every row those earlier suites left is still sitting there.
 * A sweep of the real table reads all of them; the first version of this file
 * asserted on a row count and saw 51 instead of 1.
 *
 * Verifying what a statement MEANS does not require running it on production
 * tables, so the transaction builds a same-shaped table in a throwaway schema,
 * points the search path at it, and rolls the whole thing back. The copy is
 * taken with `LIKE ... INCLUDING ALL`, so column types, defaults and check
 * constraints come along; foreign keys do not, which is why the rows below
 * reference nothing.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed so this suite needs no API key and makes no provider
// request. Without the stub, CI — which sets no key anywhere — would get an
// AI_LoadAPIKeyError delivered as an `error` stream part: the stream still
// ends cleanly and every assertion still passes, so the suite would quietly
// stop covering what it appears to cover. A machine that does have a key
// would issue a real request instead.
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

/** Where the throwaway copy of `projects` lives for the length of one test. */
const PROBE_SCHEMA = "mig0049_probe";

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
  /** How many rows the statement touched in the copied table. */
  readonly touched: number;
}

/**
 * Seed one private and one studio-visible project into a throwaway copy of the
 * table, run the migration's SQL against it, and report what the rows say
 * afterwards — then roll the whole thing back, schema included.
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
      await tx.unsafe(`CREATE SCHEMA ${PROBE_SCHEMA}`);
      await tx.unsafe(
        `CREATE TABLE ${PROBE_SCHEMA}.projects (LIKE public.projects INCLUDING ALL)`,
      );
      // The migration names `"projects"` unqualified, so the search path is
      // what decides which table it hits. LOCAL keeps it inside this
      // transaction.
      await tx.unsafe(`SET LOCAL search_path TO ${PROBE_SCHEMA}, public`);

      const [hidden] = await tx<{ id: string }[]>`
        INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'Hidden', 'vis-hidden', 'private')
        RETURNING id
      `;
      const [open] = await tx<{ id: string }[]>`
        INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'Open', 'vis-open', 'studio')
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
    // The copied table holds exactly the two rows seeded above, so this count
    // is exact. A statement without the WHERE clause rewrites both and shows up
    // here as 2 — which is the whole reason this case exists, since the
    // assertions above pass either way.
    const observed = await runMigrationOnSeededRows();
    expect(observed.touched).toBe(1);
  });
});
