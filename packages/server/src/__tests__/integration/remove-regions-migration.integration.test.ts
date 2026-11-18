// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Migration 0127 takes back what 0126 added for regions (#1556). */
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "@breatic/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const migrationDir = fileURLToPath(new URL("../../../../core/src/db/migrations/", import.meta.url));
let sql: ReturnType<typeof postgres>;
let fixtureRoot: string | undefined;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: "remove-regions-migration-test" } });
});
afterAll(async () => {
  await sql?.end({ timeout: 3 });
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
});

type Db = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;
class Rollback extends Error {}

/**
 * The statements of one migration file.
 * @param file - The migration's file name.
 * @returns Its statements, split where the file breaks them.
 */
async function statementsOf(file: string): Promise<string[]> {
  return (await readFile(resolve(migrationDir, file), "utf8")).split("--> statement-breakpoint").filter((s) => s.trim().length > 0);
}

/**
 * Run statements in order inside the transaction.
 * @param tx - The transaction.
 * @param statements - The statements.
 */
async function run(tx: Tx, statements: string[]): Promise<void> {
  for (const statement of statements) await tx.unsafe(statement);
}

/**
 * The migrations folder cut after one migration.
 * @param last - The idx of the last migration it keeps.
 * @returns The folder's path.
 */
async function migrationsUpTo(last: number): Promise<string> {
  if (fixtureRoot === undefined) {
    const cache = resolve(migrationDir, "../../../../../node_modules/.cache");
    await mkdir(cache, { recursive: true });
    fixtureRoot = await mkdtemp(resolve(cache, "remove-regions-"));
  }
  const folder = resolve(fixtureRoot, `up-to-${String(last)}`);
  await cp(migrationDir, folder, { recursive: true });
  const journal = JSON.parse(await readFile(resolve(migrationDir, "meta/_journal.json"), "utf8")) as { entries: { idx: number }[] };
  await writeFile(resolve(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= last) }));
  return folder;
}

/**
 * Migrate a database of its own and read its schema.
 * @param migrationsFolder - The migrations to run; the full set when omitted.
 * @returns The schema it ends with.
 */
async function migratedSchema(migrationsFolder?: string): Promise<unknown> {
  const name = `remove_regions_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(inject("DATABASE_URL"));
  url.pathname = `/${name}`;
  const db = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrateDatabase(url.toString(), migrationsFolder === undefined ? {} : { migrationsFolder });
    return await schemaOf(db);
  } finally {
    await db.end({ timeout: 3 });
    await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  }
}

/**
 * Every constraint, index and column of the public schema.
 * @param db - A connection or transaction.
 * @returns The schema, ordered.
 */
async function schemaOf(db: Db | Tx): Promise<unknown> {
  const constraints = await db`
    SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`;
  const indexes = await db`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`;
  const columns = await db`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`;
  return { constraints, indexes, columns };
}

/**
 * Put the database back where 0126 left it, run the body, and roll everything back.
 * @param body - What to do on the 0126 schema.
 */
async function onRegionsSchema(body: (tx: Tx) => Promise<void>): Promise<void> {
  await sql
    .begin(async (tx) => {
      await run(tx, await statementsOf("0126_regions.sql"));
      await body(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

/**
 * A user, their Studio with a Project, a credit hold and a pending transfer to a second member.
 * @param tx - The transaction.
 * @returns The Studio and the transfer it holds.
 */
async function seed(tx: Tx): Promise<{ studioId: string; transferId: string }> {
  const owner = randomUUID();
  const member = randomUUID();
  const studioId = randomUUID();
  for (const id of [owner, member]) await tx`INSERT INTO users (id, email) VALUES (${id}, ${`${id}@example.test`})`;
  await tx`INSERT INTO studios (id, created_by_user_id, slug, name, type) VALUES (${studioId}, ${owner}, ${studioId.slice(0, 30)}, 'Fixture', 'team')`;
  await tx`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${owner}, 'admin'), (${studioId}, ${member}, 'maintainer')`;
  await tx`INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studioId}, ${owner}, 'Fixture', ${`p-${studioId.slice(0, 20)}`})`;
  await tx`INSERT INTO credit_holds (studio_id, actor_user_id, reference_id, amount, expires_at) VALUES (${studioId}, ${owner}, ${randomUUID()}, '0.250000', now() + interval '1 hour')`;
  const [transfer] = await tx`
    INSERT INTO studio_transfers (studio_id, from_user_id, to_user_id, status, expires_at, share_token)
    VALUES (${studioId}, ${owner}, ${member}, 'pending', now() + interval '7 days', ${randomUUID().replaceAll("-", "")}) RETURNING id`;
  return { studioId, transferId: transfer!.id as string };
}

/**
 * Every business row the seed wrote for a Studio.
 * @param tx - The transaction.
 * @param studioId - The Studio.
 * @returns The rows, as JSON.
 */
async function rowsOf(tx: Tx, studioId: string): Promise<unknown> {
  const [row] = await tx`SELECT jsonb_build_object(
    'studio', (SELECT to_jsonb(t) FROM studios t WHERE id = ${studioId}),
    'members', (SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM studio_members t WHERE studio_id = ${studioId}),
    'projects', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM projects t WHERE studio_id = ${studioId}),
    'holds', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_holds t WHERE studio_id = ${studioId}),
    'transfers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM studio_transfers t WHERE studio_id = ${studioId})
  ) AS rows`;
  return row!.rows;
}

describe("migration 0127 removes regions", () => {
  // Through 0127, so migrations added after it do not count as a difference.
  it("leaves a database migrated through 0127 with the schema it had before 0126", async () => {
    const beforeRegions = await migratedSchema(await migrationsUpTo(125));
    expect(await migratedSchema(await migrationsUpTo(127))).toEqual(beforeRegions);
  });

  it("refuses a Studio transfer in the accepting state", async () => {
    await expect(
      sql.begin(async (tx) => {
        const { transferId } = await seed(tx);
        await tx`UPDATE studio_transfers SET status = 'accepting' WHERE id = ${transferId}`;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps a database's business rows and its schema across 0126 and 0127", async () => {
    const schema = await schemaOf(sql);
    await onRegionsSchema(async (tx) => {
      const { studioId } = await seed(tx);
      const before = await rowsOf(tx, studioId);
      await run(tx, await statementsOf("0127_remove_regions.sql"));
      expect(await rowsOf(tx, studioId)).toEqual(before);
      expect(await schemaOf(tx)).toEqual(schema);
    });
  });

  it("stops on a Studio transfer left accepting and names it", async () => {
    await onRegionsSchema(async (tx) => {
      const { transferId } = await seed(tx);
      await tx`UPDATE studio_transfers SET status = 'accepting' WHERE id = ${transferId}`;
      await expect(run(tx, await statementsOf("0127_remove_regions.sql"))).rejects.toThrow(transferId);
    });
  });
});
