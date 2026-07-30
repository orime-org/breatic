// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { migrationStyle } from "#repo-lint/checks/migration-style";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const dir = "packages/core/src/db/migrations";

/**
 * Wraps one migration body as a context.
 * @param sql The migration text.
 * @param name The file name, defaulting to a plausible one.
 * @returns A context over that one migration.
 */
function migration(sql: string, name = "0018_thing.sql") {
  return fakeContext({ [`${dir}/${name}`]: sql });
}

describe("migration-style", () => {
  it("passes a single statement with no separator", () => {
    expect(
      migrationStyle.run(migration('ALTER TABLE "a" ADD COLUMN "x" text;\n')),
    ).toEqual([]);
  });

  it("passes two statements that are separated", () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "x" text;
--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "y" text;
`;
    expect(migrationStyle.run(migration(sql))).toEqual([]);
  });

  it("catches two statements with no separator", () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "x" text;
ALTER TABLE "a" ADD COLUMN "y" text;
`;
    const findings = migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("statement-breakpoint");
  });

  it("does not count semicolons in prose", () => {
    // The first version of this check did, and reported three historical
    // migrations that each hold one statement.
    const sql = `-- The subsystem was removed; this migration drops its only artifact.
-- Another sentence; with another semicolon; and one more.
ALTER TABLE "a" ADD COLUMN "x" text;
`;
    expect(migrationStyle.run(migration(sql))).toEqual([]);
  });

  it("counts statements after an indented comment too", () => {
    const sql = `   -- indented prose; still prose.
ALTER TABLE "a" ADD COLUMN "x" text;
ALTER TABLE "a" ADD COLUMN "y" text;
`;
    expect(migrationStyle.run(migration(sql))).toHaveLength(1);
  });

  it("catches an unnamed foreign key", () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "b" uuid REFERENCES "t"("id");\n`;
    const findings = migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("CONSTRAINT");
  });

  it("passes a named foreign key", () => {
    const sql = `ALTER TABLE "a" ADD CONSTRAINT "a_b_t_id_fk" FOREIGN KEY ("b") REFERENCES "t"("id");\n`;
    expect(migrationStyle.run(migration(sql))).toEqual([]);
  });

  it("ignores REFERENCES written inside a comment", () => {
    const sql = `-- This used to be a REFERENCES clause before the rewrite.
ALTER TABLE "a" ADD COLUMN "x" text;
`;
    expect(migrationStyle.run(migration(sql))).toEqual([]);
  });

  it("reports both problems in one file", () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "b" uuid REFERENCES "t"("id");
ALTER TABLE "a" ADD COLUMN "c" text;
`;
    expect(migrationStyle.run(migration(sql))).toHaveLength(2);
  });

  it("covers the yjs migration folder as well", () => {
    const context = fakeContext({
      "packages/core/src/db/migrations-yjs/0001_a.sql":
        'ALTER TABLE "a" ADD COLUMN "x" text;\nALTER TABLE "a" ADD COLUMN "y" text;\n',
    });
    expect(migrationStyle.run(context)).toHaveLength(1);
  });

  it("fails rather than reports clean when it finds no migrations", () => {
    expect(() => migrationStyle.run(fakeContext({ "a.ts": "x" }))).toThrow(
      /matched none/,
    );
  });
});
