// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Programmatic database migration using Drizzle ORM.
 *
 * Runs all pending SQL migrations from the `migrations/` directory.
 * Called at startup by both the API server and Worker to ensure
 * the schema is always up-to-date before serving requests.
 *
 * Safe to call concurrently - Drizzle uses a lock table to prevent
 * duplicate migration runs.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import { db, yjsDb } from "@core/db/client.js";
import { migrateConfirmedGiftDatabase } from "@core/db/legacy-gift-migration.js";
import { env, MONOREPO_ROOT } from "@core/config/env.js";

/**
 * Run all pending database migrations.
 *
 * Per `AGENTS.md#library-packages-do-not-log`, this library
 * function does NOT log progress/completion. The application
 * caller (`scripts/db-migrate.ts` CLI) wraps the call and emits
 * its own console output around it.
 * @param options - Optional operator-verified confirmation for a single pre-existing manual gift.
 * @param options.legacyGiftConfirmation - The private receipt-derived confirmation, never a new grant.
 * @returns The resolved migrations folder path, so the CLI caller
 *   can include it in human-readable output without re-deriving
 *   the same `resolve(MONOREPO_ROOT, ...)` expression.
 * @throws {Error} if any migration fails (prevents service from starting)
 */
export async function runMigrations(options: { legacyGiftConfirmation?: unknown } = {}): Promise<{ migrationsFolder: string }> {
  const migrationsFolder = resolve(MONOREPO_ROOT, "packages/core/src/db/migrations");
  if (options.legacyGiftConfirmation !== undefined) {
    await migrateConfirmedGiftDatabase(env.DATABASE_URL, migrationsFolder, options.legacyGiftConfirmation);
  } else {
    await migrate(db, { migrationsFolder });
  }
  return { migrationsFolder };
}

/**
 * Run all pending migrations for the SEPARATE Yjs document store database
 * (`yjsDb` / `YJS_DATABASE_URL`).
 *
 * Uses its own migrations folder + independent `__drizzle_migrations`
 * ledger so it can never collide with the business migration journal.
 * Same no-logging library mandate as {@link runMigrations}; the CLI
 * caller emits its own output.
 * @returns The resolved yjs migrations folder path, for the CLI caller's
 *   human-readable output.
 * @throws {Error} if any migration fails (prevents service from starting)
 */
export async function runYjsMigrations(): Promise<{ migrationsFolder: string }> {
  const migrationsFolder = resolve(MONOREPO_ROOT, "packages/core/src/db/migrations-yjs");
  await migrate(yjsDb, { migrationsFolder });
  return { migrationsFolder };
}
