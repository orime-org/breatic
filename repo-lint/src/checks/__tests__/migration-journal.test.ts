// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { migrationJournal } from "#repo-lint/checks/migration-journal";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const dir = "packages/core/src/db/migrations";

/** A day in milliseconds, for writing entries relative to now. */
const DAY = 86_400_000;

/** One journal entry, as drizzle writes it. */
interface Entry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/**
 * Builds a journal out of `when` values.
 * @param whens The timestamp of each entry, in file order.
 * @returns The journal's JSON text.
 */
function journalOf(whens: readonly number[]): string {
  const entries: Entry[] = whens.map((when, index) => ({
    idx: index,
    version: "7",
    when,
    tag: `${String(index).padStart(4, "0")}_thing`,
    breakpoints: true,
  }));
  return JSON.stringify({ version: "7", dialect: "postgresql", entries });
}

/**
 * Wraps one journal as a context.
 * @param whens The timestamp of each entry, in file order.
 * @returns A context over that journal.
 */
function journal(whens: readonly number[]) {
  return fakeContext({ [`${dir}/meta/_journal.json`]: journalOf(whens) });
}

describe("migration-journal", () => {
  it("passes entries that rise, all in the past", () => {
    const now = Date.now();
    expect(
      migrationJournal.run(journal([now - 30 * DAY, now - 20 * DAY, now - DAY])),
    ).toEqual([]);
  });

  it("passes a single entry", () => {
    expect(migrationJournal.run(journal([Date.now() - DAY]))).toEqual([]);
  });

  it("catches an entry that does not rise above the one before it", () => {
    // The order in the file is the order drizzle runs them in, but what it
    // compares is the timestamp. An entry whose `when` sits below its
    // predecessor's is skipped outright on any database that already applied
    // the predecessor — with no error and a zero exit code.
    const now = Date.now();
    const findings = migrationJournal.run(
      journal([now - 10 * DAY, now - 20 * DAY]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("0001_thing");
  });

  it("catches two entries carrying the same timestamp", () => {
    // Equal is not enough: the comparison is strictly greater, so an entry
    // matching its predecessor exactly is skipped just as surely.
    const when = Date.now() - 5 * DAY;
    const findings = migrationJournal.run(journal([when, when]));
    expect(findings).toHaveLength(1);
  });

  it("catches a timestamp in the future", () => {
    // This is the one that was actually written. A future timestamp raises
    // the watermark past every real date that follows it, so the NEXT author
    // writing an honest date produces an entry that can never run.
    const findings = migrationJournal.run(
      journal([Date.now() - DAY, Date.now() + 3 * DAY]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("0001_thing");
  });

  it("tolerates a timestamp a few hours ahead, for time zones", () => {
    // Whoever writes the entry may be a day ahead of the machine running the
    // check. A whole day of slack costs nothing: the failure this guards
    // against needs the timestamp to outrun the NEXT author's real date, and
    // being a few hours ahead cannot do that.
    expect(
      migrationJournal.run(journal([Date.now() + 6 * 3_600_000])),
    ).toEqual([]);
  });

  it("reports both faults when an entry has both", () => {
    // A future timestamp that is also below its predecessor is two separate
    // things to fix, and a reader who only hears about one will fix that one
    // and be told about the other on the next run.
    const now = Date.now();
    const findings = migrationJournal.run(
      journal([now + 10 * DAY, now + 5 * DAY]),
    );
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a journal it cannot read rather than reporting clean", () => {
    // The failure this whole suite exists to remove: a guard that cannot see
    // its subject must say so, never pass.
    expect(() =>
      migrationJournal.run(
        fakeContext({ [`${dir}/meta/_journal.json`]: "not json at all" }),
      ),
    ).toThrow();
  });

  it("refuses a journal whose entries are not a list", () => {
    expect(() =>
      migrationJournal.run(
        fakeContext({
          [`${dir}/meta/_journal.json`]: JSON.stringify({ version: "7" }),
        }),
      ),
    ).toThrow();
  });

  it("names the file and the entry so the fix is one edit", () => {
    const now = Date.now();
    const findings = migrationJournal.run(
      journal([now - DAY, now - 2 * DAY]),
    );
    expect(findings[0]?.file).toBe(`${dir}/meta/_journal.json`);
    expect(findings[0]?.message).toMatch(/0000_thing/);
  });
});
