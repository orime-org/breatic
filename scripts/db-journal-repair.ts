// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Repairs a database whose migration bookkeeping predates the journal fix.
 *
 * **Anyone pulling that change must run this once against every database they
 * have.** The journal was corrected in the repository; the values already
 * written into each database were not, and nothing in the repository can
 * reach them.
 *
 * Two things are wrong on such a database.
 *
 * The recorded times. `drizzle-orm@0.45.2` decides what to run by comparing
 * against the newest `created_at` it has recorded, and it records the
 * journal's `when` verbatim (`pg-core/dialect.js`). A database migrated
 * before the fix therefore holds a mark of 2026-08-18, which is above every
 * corrected entry — so the next migration anyone writes sits below the mark
 * and never runs, with a zero exit code.
 *
 * The migrations that were already skipped. Correcting the journal does not
 * bring them back, for the same reason. Measured on one worktree's database:
 * `0051_purge_pre_parts_messages` had never run while `pnpm db:migrate`
 * reported success every time.
 *
 * Reports by default; `--apply` does the work. Running it twice is a no-op:
 * the timestamp rewrite is keyed on the values it replaces, and the second
 * pass finds nothing missing.
 *
 * Usage, from the repository root:
 *   pnpm db:journal-repair
 *   pnpm db:journal-repair --apply
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRoot, loadEnv } from "./load-env.js";

const ROOT = findRoot();
const MIGRATIONS = resolve(ROOT, "packages/core/src/db/migrations");
loadEnv(ROOT);

const core = (await import("../packages/core/dist/index.js")) as {
  initCore: (env: NodeJS.ProcessEnv) => void;
  rawPg: {
    (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    unsafe: (sql: string) => Promise<unknown[]>;
  };
};
core.initCore(process.env);


const apply = process.argv.includes("--apply");
const journal = JSON.parse(
  readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf-8"),
) as { entries: { idx: number; tag: string; when: number }[] };

// Step one: the recorded times. Keyed on the value each row currently holds,
// which is the journal's own history — so this is a no-op once run.
const OLD_TO_NEW = readFileSync(
  resolve(MIGRATIONS, "meta/journal-created-at-fix.sql"),
  "utf-8",
);
if (apply) await core.rawPg.unsafe(OLD_TO_NEW);

const recorded = new Set(
  (
    (await core.rawPg`
      SELECT created_at::text FROM drizzle.__drizzle_migrations
    `) as { created_at: string }[]
  ).map((row) => Number(row.created_at)),
);
console.log(
  `${apply ? "timestamps corrected; " : ""}journal ${journal.entries.length} entries, database ${recorded.size} rows`,
);

// Step two: whatever the watermark skipped. Applied in journal order, each
// with its own row, so the database ends up recording what it actually ran.
const missing = journal.entries.filter((entry) => !recorded.has(entry.when));
if (missing.length === 0) {
  console.log("nothing missing");
  process.exit(0);
}
console.log("missing:", missing.map((entry) => entry.tag).join(", "));
if (!apply) {
  console.log("run again with --apply to apply them");
  process.exit(0);
}
for (const entry of missing) {
  const sql = readFileSync(resolve(MIGRATIONS, `${entry.tag}.sql`), "utf-8");
  for (const fragment of sql.split("--> statement-breakpoint")) {
    if (fragment.trim() === "") continue;
    await core.rawPg.unsafe(fragment);
  }
  await core.rawPg`
    INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
    VALUES (${entry.tag}, ${entry.when})
  `;
  console.log("applied", entry.tag);
}
process.exit(0);
