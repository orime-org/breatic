// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** The journal drizzle writes into every folder it manages a set in. */
const JOURNAL = /\/meta\/_journal\.json$/;

/**
 * How far ahead of this machine's clock an entry may sit.
 *
 * Whoever writes an entry may be a whole day ahead of the machine running the
 * check, so anything tighter than a day reports honest entries as future ones.
 * The slack is not free — entries in this journal have landed within an hour
 * of each other, so a day of drift can genuinely outrun the next author — but
 * a false report on every timezone-crossing entry costs more than the rare
 * miss, and the entries that made this check necessary sat days out, not
 * hours: 0052 was written 4.7 days ahead, 0050 3.8 days.
 */
const CLOCK_SLACK_MS = 86_400_000;

/** One entry, reduced to what this check asks about. */
interface Entry {
  /** The timestamp drizzle compares against the database's high-water mark. */
  readonly when: number;
  /** The migration's name, so a finding says which one to edit. */
  readonly tag: string;
}

/**
 * Reads the entries out of a journal, or refuses.
 *
 * Every failure here throws rather than returning nothing to look at. A
 * journal this cannot parse is a journal whose ordering nobody has checked,
 * and reporting that as clean is the exact failure mode this suite exists to
 * remove.
 * @param text The journal's contents.
 * @param file Repo-relative path, for the error.
 * @returns The entries, in file order.
 * @throws {Error} When the file is not JSON, or holds no entry list.
 */
function readEntries(text: string, file: string): Entry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${file} is not JSON, so its ordering cannot be read.`, {
      cause,
    });
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(
      `${file} has no \`entries\` list, so there is nothing to check its ordering against. Drizzle writes one into every journal it maintains; a journal without one is not a journal this check can read.`,
    );
  }
  return entries.map((entry: unknown, index: number) => {
    const record = entry as Record<string, unknown>;
    const when = record["when"];
    if (typeof when !== "number" || !Number.isFinite(when)) {
      throw new Error(
        `${file} entry ${index} has no numeric \`when\`, which is the value drizzle compares. Nothing can be said about the ordering without it.`,
      );
    }
    return {
      when,
      tag: typeof record["tag"] === "string" ? record["tag"] : `entry ${index}`,
    };
  });
}

/**
 * Migration journal timestamps rise, and none is dated in the future.
 *
 * `drizzle-orm@0.45.2` decides what to run by a high-water mark, not by what
 * it has already applied: `pg-core/dialect.js` reads the single newest row
 * from `__drizzle_migrations` and runs every journal entry whose `when` is
 * greater than that one value. Which entries the database has actually seen
 * never enters into it — the `hash` column recording them is written and
 * never read back.
 *
 * Two things follow, and this check asks about both.
 *
 * An entry whose `when` does not rise above its predecessor's can never run
 * on a database that already applied the predecessor. It is not refused, not
 * warned about, and the command still exits zero — the table it needed simply
 * is not there.
 *
 * An entry dated in the future is worse, because the entry it breaks is one
 * nobody has written yet. It lifts the mark past every honest date that
 * follows, so the next author dates their migration today, and today is
 * already behind the mark. That is what happened here: 0052 was written with
 * a timestamp 4.7 days out, and 0053 could only stay above it by going out
 * further still.
 *
 * Upstream now agrees this is the wrong judgement — drizzle v1 applies every
 * missing migration regardless of order — but that release is still a
 * pre-release on npm, where `latest` remains 0.45.2. Until it lands, keeping
 * the journal monotonic and in the past is what keeps a migration from
 * silently never running.
 */
export const migrationJournal = {
  name: "migration-journal",
  description: "Migration timestamps rise, and none is dated in the future",
  run(context: CheckContext): Finding[] {
    const journals = context.files(
      (path) => JOURNAL.test(path),
      "drizzle migration journals",
    );

    const ceiling = Date.now() + CLOCK_SLACK_MS;
    const findings: Finding[] = [];
    for (const file of journals) {
      const entries = readEntries(context.read(file), file);
      let previous: Entry | undefined;
      for (const entry of entries) {
        if (previous !== undefined && entry.when <= previous.when) {
          findings.push({
            file,
            message: `\`${entry.tag}\` carries a \`when\` of ${entry.when}, which is not above \`${previous.tag}\`'s ${previous.when}. Drizzle runs an entry only when its \`when\` exceeds the newest timestamp the database has recorded, so on any database that already applied \`${previous.tag}\` this one is skipped — with no error and a zero exit code. Raise it above ${previous.when}.`,
          });
        }
        if (entry.when > ceiling) {
          findings.push({
            file,
            message: `\`${entry.tag}\` is dated ${new Date(entry.when).toISOString()}, which is in the future. That lifts the high-water mark past every honest date that follows it, so the next migration anyone writes is dated below the mark and can never run. Date it when it was written.`,
          });
        }
        previous = entry;
      }
    }
    return findings;
  },
} satisfies Check;
