// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Adds a hand-written migration to drizzle's journal.
 *
 * Migrations here are written by hand — drizzle-kit's snapshot has been frozen
 * at 0017 since 0018, so `db:generate` would regenerate history wrongly — and
 * the journal entry was written by hand with them. That left `when` with no
 * source: drizzle takes it from the clock when it generates a migration, and
 * a person typing it takes it from nowhere. Measured across 54 entries, all
 * 54 disagreed with when the migration was actually created — by as much as
 * fifty days behind, and close to five days ahead.
 *
 * Ahead is the direction that breaks things. `drizzle-orm@0.45.2` decides
 * what to run from a high-water mark rather than from what it has applied
 * (`pg-core/dialect.js`: read the single newest `created_at`, run everything
 * above it), so an entry dated in the future lifts the mark past every honest
 * date that follows and those migrations never run — no error, exit code
 * zero. Upstream changed this in v1, which is still a pre-release on npm.
 *
 * So this exists to take the number out of anyone's hands: it reads the clock
 * the same way drizzle would. `repo-lint`'s `migration-journal` check is the
 * backstop for anyone who edits the file directly anyway.
 *
 * Usage, from the repository root:
 *   pnpm db:journal-add 0054_my_migration
 *   pnpm db:journal-add 0054_my_migration --yjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where each database's journal lives, relative to the repository root. */
const JOURNALS = {
  business: "packages/core/src/db/migrations/meta/_journal.json",
  yjs: "packages/core/src/db/migrations-yjs/meta/_journal.json",
} as const;

/** One entry, in the shape drizzle writes and reads. */
interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** A journal file, in the shape drizzle writes and reads. */
interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/**
 * Appends an entry for a migration that is already written.
 * @param file Absolute path of the journal.
 * @param tag The migration's name without `.sql`, e.g. `0054_my_migration`.
 * @returns The entry that was appended.
 * @throws {Error} If the journal is unreadable, the tag is already in it, or
 *   the clock would produce a value the previous entry already holds — which
 *   would make the new migration unrunnable on any database that has the
 *   previous one, and is worth stopping for rather than nudging past.
 */
function appendEntry(file: string, tag: string): JournalEntry {
  const journal = JSON.parse(readFileSync(file, "utf-8")) as Journal;
  if (!Array.isArray(journal.entries)) {
    throw new Error(`${file} has no \`entries\` list.`);
  }
  if (journal.entries.some((entry) => entry.tag === tag)) {
    throw new Error(`${file} already has an entry for ${tag}.`);
  }

  const last = journal.entries.at(-1);
  const when = Date.now();
  if (last !== undefined && when <= last.when) {
    throw new Error(
      `The clock reads ${when}, which is not above \`${last.tag}\`'s ${last.when}. Drizzle runs an entry only when its \`when\` exceeds the newest timestamp the database recorded, so this migration could never run where that one already has. Either this machine's clock is behind, or that entry is dated in the future and needs fixing first.`,
    );
  }

  const entry: JournalEntry = {
    idx: (last?.idx ?? -1) + 1,
    version: last?.version ?? "7",
    when,
    tag,
    breakpoints: true,
  };
  journal.entries.push(entry);
  writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
  return entry;
}

/**
 * Reads the arguments and appends the entry.
 * @throws {Error} If no tag was given, or `appendEntry` refuses.
 */
function main(): void {
  const args = process.argv.slice(2);
  const tag = args.find((arg) => !arg.startsWith("--"));
  if (tag === undefined) {
    throw new Error(
      "Usage: pnpm db:journal-add <tag> [--yjs]\n  <tag> is the migration's file name without `.sql`, e.g. 0054_my_migration",
    );
  }
  const which = args.includes("--yjs") ? "yjs" : "business";
  const file = resolve(import.meta.dirname, "..", JOURNALS[which]);
  const entry = appendEntry(file, tag);
  // A script, not a library: telling the person who ran it what it did is the
  // whole output, and there is no caller to return it to.
  console.log(
    `Added ${entry.tag} as idx ${entry.idx} with when ${entry.when} (${new Date(entry.when).toISOString()}) to the ${which} journal.`,
  );
}

main();
