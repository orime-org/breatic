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
  it("passes a single statement with no separator", async () => {
    await expect(
      migrationStyle.run(migration('ALTER TABLE "a" ADD COLUMN "x" text;\n')),
    ).resolves.toEqual([]);
  });

  it("passes two statements that are separated", async () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "x" text;
--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "y" text;
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("catches two statements with no separator", async () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "x" text;
ALTER TABLE "a" ADD COLUMN "y" text;
`;
    const findings = await migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("statement-breakpoint");
  });

  it("catches statements left unseparated beside a separated pair", async () => {
    // The check used to ask whether the file held a marker at all, so one
    // anywhere vouched for every boundary in it. Drizzle splits on the marker
    // and runs each fragment; a fragment holding two statements still goes
    // out as one raw call, while the file reads as compliant.
    const sql = `ALTER TABLE "a" ADD COLUMN "x" text;
--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "y" text;
ALTER TABLE "a" ADD COLUMN "z" text;
`;
    const findings = await migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(4);
  });

  it("passes three statements each separated from the next", async () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "x" text;
--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "y" text;
--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "z" text;
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("reads a DO block as the one statement it is", async () => {
    // Three semicolons, one statement: a semicolon inside a dollar-quoted
    // body ends nothing. Counting them reported this shape — which 0030 uses
    // twice — as several statements crammed together.
    const sql = `DO $$ BEGIN
	ALTER TABLE "a" ADD CONSTRAINT "a_b_fk" FOREIGN KEY ("b") REFERENCES "t"("id");
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("sees an unnamed foreign key inside a DO block", async () => {
    // The blind spot the parser introduced and the text scan did not have:
    // PostgreSQL stores a DO block's body as an opaque string, and every
    // foreign key in this repository is declared inside one, in the
    // idempotent shape drizzle emits.
    const sql = `DO $$ BEGIN
	ALTER TABLE "a" ADD COLUMN "b" uuid REFERENCES "t"("id");
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
`;
    const findings = await migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("CONSTRAINT");
  });

  it("passes a named foreign key inside a DO block", async () => {
    // The shape 0030 and the other hand-written migrations actually use.
    const sql = `DO $$ BEGIN
	ALTER TABLE "a" ADD CONSTRAINT "a_b_t_id_fk" FOREIGN KEY ("b") REFERENCES "t"("id");
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("does not count semicolons in prose", async () => {
    // An earlier version did, and reported three historical migrations that
    // each hold one statement.
    const sql = `-- The subsystem was removed; this migration drops its only artifact.
-- Another sentence; with another semicolon; and one more.
ALTER TABLE "a" ADD COLUMN "x" text;
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("catches an unnamed foreign key", async () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "b" uuid REFERENCES "t"("id");\n`;
    const findings = await migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("CONSTRAINT");
  });

  it("passes a named foreign key", async () => {
    const sql = `ALTER TABLE "a" ADD CONSTRAINT "a_b_t_id_fk" FOREIGN KEY ("b") REFERENCES "t"("id");\n`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("catches an unnamed foreign key beside an unrelated named constraint", async () => {
    // The shape that defeated the text scan: it asked whether the file held
    // the word CONSTRAINT, and a primary key or a unique constraint puts it
    // there for reasons of its own. 0011 and 0017 are already written this
    // way, so the next new table written like this would have gone unseen.
    const sql = `CREATE TABLE "widget_keys" (
	"studio_id" uuid NOT NULL REFERENCES "studios"("id"),
	"token" varchar(64) NOT NULL,
	CONSTRAINT "widget_keys_token_unique" UNIQUE("token")
);
`;
    const findings = await migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  it("catches an unnamed table-level foreign key", async () => {
    const sql = `CREATE TABLE "a" (
	"b" uuid,
	FOREIGN KEY ("b") REFERENCES "t"("id")
);
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toHaveLength(1);
  });

  it("ignores REFERENCES written inside a comment", async () => {
    const sql = `-- This used to be a REFERENCES clause before the rewrite.
ALTER TABLE "a" ADD COLUMN "x" text;
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("reports both problems in one file", async () => {
    const sql = `ALTER TABLE "a" ADD COLUMN "b" uuid REFERENCES "t"("id");
ALTER TABLE "a" ADD COLUMN "c" text;
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toHaveLength(2);
  });

  it("covers the yjs migration folder as well", async () => {
    const context = fakeContext({
      "packages/core/src/db/migrations-yjs/0001_a.sql":
        'ALTER TABLE "a" ADD COLUMN "x" text;\nALTER TABLE "a" ADD COLUMN "y" text;\n',
    });
    await expect(migrationStyle.run(context)).resolves.toHaveLength(1);
  });

  it("accepts a migration that ends with the marker", async () => {
    // Splitting on the marker leaves an empty trailing piece, and the parser
    // rejects an empty query outright — so a perfectly ordinary file was
    // blamed as unreadable SQL.
    const sql = `ALTER TABLE "a" ADD COLUMN "x" text;
--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "y" text;
--> statement-breakpoint
`;
    await expect(migrationStyle.run(migration(sql))).resolves.toEqual([]);
  });

  it("reports the right line in a file holding non-ASCII text", async () => {
    // The parser counts in bytes; the file is read as a string. A comment
    // with any non-ASCII character in it pushes every reported line down,
    // and five migrations here already contain some.
    const sql = `-- 中文注释，占的字节数比字符数多
ALTER TABLE "a" ADD COLUMN "b" uuid REFERENCES "t"("id");
`;
    const findings = await migrationStyle.run(migration(sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  it("refuses rather than reports clean on SQL it cannot read", async () => {
    // A file the parser cannot read is a file neither question can be asked
    // of. Passing it over would let through exactly the migration nothing
    // could inspect.
    await expect(
      migrationStyle.run(migration("ALTER TABEL nonsense (((;\n")),
    ).rejects.toThrow(/cannot be answered|cannot parse|not SQL/);
  });

  it("fails rather than reports clean when it finds no migrations", async () => {
    await expect(
      migrationStyle.run(fakeContext({ "a.ts": "x" })),
    ).rejects.toThrow(/matched none/);
  });
});
