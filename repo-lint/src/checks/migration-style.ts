// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** The two hand-written migration folders. */
const MIGRATION = /^packages\/core\/src\/db\/migrations(-yjs)?\/[^/]+\.sql$/;

/** The marker drizzle splits a migration file on. */
const BREAKPOINT = "--> statement-breakpoint";

/**
 * Drops SQL line comments so prose is not read as code.
 *
 * The first version of this check counted every semicolon in the file.
 * Migration headers here are long prose comments, and prose contains
 * semicolons — "the subsystem was removed; this migration drops its
 * artifact". That version reported three historical migrations as
 * violations, each of which in fact holds a single statement, and nearly
 * had three untouchable files rewritten.
 * @param sql The migration's text.
 * @returns The same text with whole-line comments removed.
 */
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/**
 * Hand-written migrations separate their statements and name their keys.
 *
 * Every migration since 0018 is hand-written: drizzle-kit's snapshot is
 * frozen at 0017, so `db:generate` would regenerate history wrongly. Two
 * conventions the tool used to emit are therefore the author's job now,
 * and #1839 shipped a migration that missed both.
 *
 * Statement separation, because drizzle splits a file on the breakpoint
 * marker and runs each fragment separately. Without it the whole file goes
 * out as one `sql.raw()` call, which happens to work through postgres.js's
 * simple protocol — so the file looks fine locally while differing from
 * every other migration in the folder, and stops working the moment a
 * statement needs to run outside the implicit batch.
 *
 * Named foreign keys, because `REFERENCES t(id)` without a constraint name
 * lets PostgreSQL invent one. Nobody can then drop or alter that constraint
 * without querying the catalog to find out what it was called.
 */
export const migrationStyle = {
  name: "migration-style",
  description: "Migrations separate statements and name their foreign keys",
  run(context: CheckContext): Finding[] {
    const migrations = context.files(
      (path) => MIGRATION.test(path),
      "hand-written migrations",
    );

    const findings: Finding[] = [];
    for (const file of migrations) {
      const sql = context.read(file);
      const code = withoutComments(sql);

      const statements = (code.match(/;/g) ?? []).length;
      if (statements > 1 && !sql.includes(BREAKPOINT)) {
        findings.push({
          file,
          message: `${statements} statements but no \`${BREAKPOINT}\`. Drizzle splits on that marker and runs each fragment separately; without it the file goes out as one raw call.`,
        });
      }

      if (/\bREFERENCES\b/i.test(code) && !/\bCONSTRAINT\b/i.test(code)) {
        findings.push({
          file,
          message:
            "Foreign key with no explicit CONSTRAINT name. PostgreSQL will invent one, and nobody can drop or alter it later without querying the catalog to find out what it was called.",
        });
      }
    }
    return findings;
  },
} satisfies Check;
