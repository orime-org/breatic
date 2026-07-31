// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { loadModule, parsePlpgsqlBody, parseSql } from "plpgsql-parser";
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** The two hand-written migration folders. */
const MIGRATION = /^packages\/core\/src\/db\/migrations(-yjs)?\/[^/]+\.sql$/;

/** The marker drizzle splits a migration file on. */
const BREAKPOINT = "--> statement-breakpoint";

/**
 * How many bytes a piece of the file takes, which is what the parser counts.
 * @param text Any slice of the migration.
 * @returns Its length in UTF-8 bytes.
 */
function byteLength(text: string): number {
  return Buffer.from(text, "utf8").length;
}

/**
 * Turns an offset the parser reported into the line a reader would call it.
 *
 * The parser counts bytes; the file was read as a string. Every character
 * outside ASCII makes the two disagree, and five migrations here already
 * carry some — so the offset is converted through the same encoding the file
 * was read with rather than used as if it indexed characters.
 *
 * Then it skips forward over whitespace. A statement's span begins
 * immediately after the previous statement's semicolon, so its offset lands
 * on the newline ending the previous line and the number would come out one
 * short of the line the statement is written on.
 * @param sql The migration's text.
 * @param byteOffset A byte offset into it, as the parser reports.
 * @returns The one-based line number.
 */
function lineAt(sql: string, byteOffset: number): number {
  const bytes = Buffer.from(sql, "utf8");
  const from = bytes
    .subarray(0, Math.max(byteOffset, 0))
    .toString("utf8").length;
  const begins = from + (sql.slice(from).match(/^\s*/)?.[0].length ?? 0);
  return sql.slice(0, begins).split("\n").length;
}

/** One foreign key, and the name the author gave it. */
interface ForeignKey {
  /** The name written down, or null where PostgreSQL would invent one. */
  readonly name: string | null;
  /** Character offset of the constraint in the file. */
  readonly offset: number;
}

/**
 * Collects every foreign-key constraint anywhere in a parse tree.
 *
 * Walked rather than read off a known path: a foreign key can be a column
 * constraint, a table constraint, or an `ALTER TABLE` action, and each sits
 * somewhere different in the tree. What they share is the node the parser
 * produces for a constraint, so that is what is looked for.
 * @param node Any node of the parse tree.
 * @param found The accumulator. Mutated.
 */
function collectForeignKeys(node: unknown, found: ForeignKey[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectForeignKeys(item, found);
    return;
  }
  const record = node as Record<string, unknown>;
  const constraint = record["Constraint"];
  if (typeof constraint === "object" && constraint !== null) {
    const fields = constraint as Record<string, unknown>;
    if (fields["contype"] === "CONSTR_FOREIGN") {
      found.push({
        name: typeof fields["conname"] === "string" ? fields["conname"] : null,
        offset: typeof fields["location"] === "number" ? fields["location"] : 0,
      });
    }
  }
  for (const value of Object.values(record)) collectForeignKeys(value, found);
}

/**
 * Every `DO $$ ... $$` block in a tree, with its body and where it sits.
 *
 * PostgreSQL parses a DO block's body as an opaque string — it is PL/pgSQL,
 * read at execution time by a different parser — so a foreign key declared
 * inside one is invisible to the SQL tree. Ours are all declared inside one,
 * in the idempotent shape drizzle emits, which made this the blind spot that
 * mattered most.
 * @param node Any node of the parse tree.
 * @param found The accumulator. Mutated.
 */
function collectDoBlocks(
  node: unknown,
  found: Array<{ body: string; offset: number }>,
): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectDoBlocks(item, found);
    return;
  }
  const record = node as Record<string, unknown>;
  const statement = record["DoStmt"];
  if (typeof statement === "object" && statement !== null) {
    const args = (statement as Record<string, unknown>)["args"];
    if (Array.isArray(args)) {
      for (const arg of args) {
        const element = (arg as Record<string, unknown>)["DefElem"];
        if (typeof element !== "object" || element === null) continue;
        const fields = element as Record<string, unknown>;
        if (fields["defname"] !== "as") continue;
        const value = (fields["arg"] as Record<string, unknown> | undefined)?.[
          "String"
        ] as Record<string, unknown> | undefined;
        const body = value?.["sval"];
        if (typeof body === "string") {
          found.push({
            body,
            offset:
              typeof fields["location"] === "number" ? fields["location"] : 0,
          });
        }
      }
    }
  }
  for (const value of Object.values(record)) collectDoBlocks(value, found);
}

/**
 * The SQL statements written inside a PL/pgSQL body.
 *
 * The PL/pgSQL parser hands each one back as the text it was written as, so
 * each goes to the SQL parser in turn. Nothing here takes the body apart by
 * hand — every step is one parser or the other.
 * @param node Any node of the PL/pgSQL parse tree.
 * @param found The accumulator. Mutated.
 * @returns The SQL each embedded statement holds.
 */
function embeddedStatements(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) embeddedStatements(item, found);
    return found;
  }
  const record = node as Record<string, unknown>;
  const expression = record["PLpgSQL_expr"];
  if (typeof expression === "object" && expression !== null) {
    const query = (expression as Record<string, unknown>)["query"];
    if (typeof query === "string") found.push(query);
  }
  for (const value of Object.values(record)) embeddedStatements(value, found);
  return found;
}

/** One migration, as the parser sees it. */
interface ParsedMigration {
  /** Character offset of each statement, in order. */
  readonly starts: number[];
  /** Every foreign key the file declares. */
  readonly foreignKeys: ForeignKey[];
}

/**
 * Reads a migration with PostgreSQL's own parser.
 *
 * Both questions this check asks — how many statements is this, and does each
 * foreign key carry a name — are about SQL structure, and every attempt to
 * answer them from the text was wrong in a way only real files revealed.
 * Counting semicolons made `DO $$ ... END $$;` look like three statements,
 * because a semicolon inside a dollar-quoted body ends nothing; 0030 holds
 * two of those. Asking whether the file contains the word CONSTRAINT let an
 * unnamed foreign key through whenever the same table also declared a primary
 * key or a unique constraint, which 0011 and 0017 already do.
 *
 * So the file goes to the parser PostgreSQL itself uses, compiled to
 * WebAssembly — not a reimplementation of it. Measured over the 47 migrations
 * here: this parser reads all 47, while the best-maintained reimplementation
 * on npm reads 46 and fails on 0037. That is the drift that makes a
 * reimplementation the wrong dependency for a guard, and it is already real
 * rather than hypothetical.
 * @param sql The migration's text.
 * @param file Repo-relative path, for the error.
 * @returns The statement starts and the foreign keys.
 * @throws {Error} When the file cannot be parsed as PostgreSQL.
 */
async function readMigration(
  sql: string,
  file: string,
): Promise<ParsedMigration> {
  await loadModule();
  let tree: unknown;
  try {
    tree = await parseSql(sql);
  } catch (cause) {
    throw new Error(
      `${file} is not SQL PostgreSQL can parse, so neither of this check's questions can be answered about it. Reporting it clean would pass exactly the file nothing could read.`,
      { cause },
    );
  }
  const statements = (tree as { stmts?: unknown }).stmts;
  const starts = Array.isArray(statements)
    ? statements.map((statement: unknown) => {
        const at = (statement as Record<string, unknown>)["stmt_location"];
        return typeof at === "number" ? at : 0;
      })
    : [];
  const foreignKeys: ForeignKey[] = [];
  collectForeignKeys(tree, foreignKeys);

  // And again inside every DO block, whose body the SQL parser only ever sees
  // as a string. Every foreign key in this repository is declared inside one.
  const blocks: Array<{ body: string; offset: number }> = [];
  collectDoBlocks(tree, blocks);
  for (const block of blocks) {
    for (const statement of embeddedStatements(
      await parsePlpgsqlBody(`DO $$${block.body}$$;`),
    )) {
      const inside: ForeignKey[] = [];
      collectForeignKeys(await parseSql(statement), inside);
      // Reported at the DO block, not inside it: the inner parser counts
      // lines within the body, and the two numbering schemes are not worth
      // splicing together for a finding that names the block anyway.
      foreignKeys.push(
        ...inside.map((key) => ({ name: key.name, offset: block.offset })),
      );
    }
  }
  return { starts, foreignKeys };
}

/**
 * Reports fragments drizzle would send as a single call.
 *
 * Each fragment is split off and parsed on its own, which is exactly what
 * drizzle does with the file: split on the marker, send each piece. Trying
 * instead to place whole-file statement offsets either side of the marker
 * offsets does not work, and measuring showed why — the two spellings of the
 * marker put it on opposite sides. Written on its own line it falls inside
 * the following statement's span; written after the closing semicolon, which
 * is how 0030 is written throughout, it falls inside the preceding one's. No
 * comparison of offsets separates those two, and splitting the text makes the
 * question disappear.
 * @param file Repo-relative path, for the finding.
 * @param sql The migration's text.
 * @returns One finding per fragment holding more than one statement.
 * @throws {Error} When a fragment cannot be parsed on its own.
 */
async function crowdedFragments(
  file: string,
  sql: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let offset = 0;
  for (const fragment of sql.split(BREAKPOINT)) {
    // A file ending with the marker leaves an empty piece behind, and the
    // parser rejects an empty query outright — so an ordinary migration was
    // blamed as unreadable SQL. Nothing to separate in a piece holding no
    // statement, so there is nothing to ask about it either.
    if (fragment.trim() === "") {
      offset += fragment.length + BREAKPOINT.length;
      continue;
    }
    const { starts } = await readMigration(fragment, file);
    if (starts.length > 1) {
      findings.push({
        file,
        line: lineAt(sql, byteLength(sql.slice(0, offset)) + (starts[1] ?? 0)),
        message: `this statement shares a fragment with the one before it — ${starts.length} statements between two \`${BREAKPOINT}\` markers. Drizzle splits on that marker and runs each fragment separately, so every boundary needs one of its own; a fragment holding several statements goes out as a single raw call however many markers sit elsewhere in the file.`,
      });
    }
    offset += fragment.length + BREAKPOINT.length;
  }
  return findings;
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
 *
 * Both are asked of the file before it is ever run, which is the point of
 * asking them here rather than of the database afterwards: a query against
 * the catalogue can only report a name that is already in the deployed
 * schema, and putting that right takes another migration. A file that has
 * not run yet takes an edit.
 */
export const migrationStyle = {
  name: "migration-style",
  description: "Migrations separate statements and name their foreign keys",
  async run(context: CheckContext): Promise<Finding[]> {
    const migrations = context.files(
      (path) => MIGRATION.test(path),
      "hand-written migrations",
    );

    const findings: Finding[] = [];
    for (const file of migrations) {
      const sql = context.read(file);
      const { foreignKeys } = await readMigration(sql, file);

      findings.push(...(await crowdedFragments(file, sql)));

      for (const key of foreignKeys) {
        if (key.name !== null) continue;
        findings.push({
          file,
          line: lineAt(sql, key.offset),
          message:
            "this foreign key carries no CONSTRAINT name, so PostgreSQL invents one. Nobody can drop or alter it later without first querying the catalogue to find out what it was called — and by then the invented name is in the deployed database, where putting it right takes another migration rather than an edit here.",
        });
      }
    }
    return findings;
  },
} satisfies Check;
