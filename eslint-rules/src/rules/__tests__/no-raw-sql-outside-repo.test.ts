// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noRawSqlOutsideRepo } from "../no-raw-sql-outside-repo";

const ruleTester = new RuleTester();

ruleTester.run("no-raw-sql-outside-repo", noRawSqlOutsideRepo, {
  valid: [
    // A service owns the atomicity boundary and hands the transaction to
    // repos; forbidding this would push transactions into one repo, and a
    // transaction spans tables.
    { code: "await db.transaction(async (tx) => { await repo.save(tx); });" },
    // Calling a repo is the whole point.
    { code: "const rows = await projectsRepo.listForUser(userId);" },
    // A local named sql that is not the driver's tag.
    { code: "const sql = buildQueryString();\nreturn sql.length;" },
    // The words in prose. Comments are not in the tree, so a doc block
    // showing example SQL cannot match — which the text guard needed a
    // comment stripper to achieve.
    { code: "// db.select from the projects table\nexport const x = 1;" },
    // A member expression whose last segment is not a database handle. The
    // rule reads the segment next to the method, so widening it to member
    // expressions must not start reporting every `.select(` in the codebase.
    { code: "const rows = results.list.select((row) => row.id);" },
    { code: "const one = client.query.select();" },
  ],
  invalid: [
    {
      code: "const rows = await db.select().from(projects);",
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: "await db.insert(projects).values(row);",
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: "await db.update(projects).set(row);",
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: "await db.delete(projects);",
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: "const rows = await sql`SELECT * FROM projects`;",
      errors: [{ messageId: "rawTemplate" }],
    },
    {
      code: "const rows = await rawPg`SELECT 1`;",
      errors: [{ messageId: "rawTemplate" }],
    },
    {
      // A transaction handle reaches the same tables the same way. The text
      // guard matched the literal `db.` and let this through.
      code: "await db.transaction(async (tx) => { await tx.insert(projects).values(row); });",
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      // Reached through a namespace import. The bash guard this replaced
      // matched `\bdb\.` and caught it; reading only a bare identifier as the
      // handle lost that, and namespace imports are the prevailing style in
      // the packages this rule governs.
      code: "const rows = await core.db.select().from(projects);",
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: "await this.db.insert(projects).values(row);",
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      // Same loss on the tag side: the bash guard matched the text ``sql` ``
      // wherever it appeared, including behind a namespace.
      code: "const rows = await pg.sql`SELECT * FROM projects`;",
      errors: [{ messageId: "rawTemplate" }],
    },
    {
      code: "const rows = await driver.rawPg`SELECT 1`;",
      errors: [{ messageId: "rawTemplate" }],
    },
  ],
});
