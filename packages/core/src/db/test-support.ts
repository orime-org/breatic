/**
 * Integration-test database support.
 *
 * `@breatic/core` is the single home of Drizzle ORM (CLAUDE.md
 * "@shared vs @core ownership"): no other package depends on
 * `drizzle-orm` directly. These helpers let downstream integration
 * tests (e.g. `@breatic/server`) build a Drizzle client and run
 * migrations against an arbitrary connection URL - typically a fresh
 * testcontainer Postgres whose URL is only known at runtime - WITHOUT
 * importing `drizzle-orm` themselves and WITHOUT touching the
 * env-bound singleton {@link db}.
 *
 * Both helpers go through {@link createPgClient} so test connections
 * inherit the same production-safety lifecycle defaults as the rest of
 * the codebase.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import type { Sql } from "postgres";
import { createPgClient } from "@core/db/client.js";
import { MONOREPO_ROOT } from "@core/config/env.js";
import * as schema from "@core/db/schema.js";

/**
 * A schema-bound Drizzle client plus its underlying postgres.js client.
 *
 * The caller owns `client` and must `await client.end()` during
 * teardown.
 */
export interface TestDb {
  /** Drizzle ORM instance bound to the full {@link schema}. */
  db: PostgresJsDatabase<typeof schema>;
  /** The underlying postgres.js client, for teardown / raw queries. */
  client: Sql;
}

/**
 * Build a schema-bound Drizzle client for an arbitrary connection URL.
 *
 * Because the returned `db` shares this package's single Drizzle
 * version, inserts against {@link schema} are fully typed in the
 * caller - no `as any` cast to bridge a cross-package version mismatch.
 *
 * @param url - Postgres connection URL (e.g. a testcontainer URI)
 * @param max - Pool size; defaults to 3 for seed-heavy integration tests
 * @returns The Drizzle instance and its underlying client
 *
 * @example
 *   const { db, client } = createTestDb(containerUrl);
 *   await db.insert(schema.users).values({ ... });
 *   await client.end();
 */
export function createTestDb(url: string, max = 3): TestDb {
  const client = createPgClient(url, { name: "core-integration-test", max });
  return { db: drizzle(client, { schema }), client };
}

/**
 * Run all pending migrations against an arbitrary connection URL.
 *
 * Unlike {@link runMigrations} (which migrates the env-bound singleton
 * {@link db}), this targets a caller-supplied URL - used by test global
 * setup to migrate a freshly-started container before any test runs.
 * Creates a throwaway single-connection client and closes it before
 * returning, so it leaves no open pool behind.
 *
 * @param url - Postgres connection URL to migrate
 * @returns The resolved migrations folder path
 * @throws Error if any migration fails
 */
export async function migrateDatabase(url: string): Promise<{ migrationsFolder: string }> {
  const migrationsFolder = resolve(MONOREPO_ROOT, "packages/core/src/db/migrations");
  const client = createPgClient(url, { name: "core-integration-migrate", max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    return { migrationsFolder };
  } finally {
    await client.end();
  }
}
