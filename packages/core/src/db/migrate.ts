// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { db } from "@core/db/client.js";
import { MONOREPO_ROOT } from "@core/config/env.js";

/**
 * Run all pending database migrations.
 *
 * Per CLAUDE.md "core and shared must not log" mandate, this library
 * function does NOT log progress/completion. The application
 * caller (`scripts/db-migrate.ts` CLI) wraps the call and emits
 * its own console output around it.
 * @returns The resolved migrations folder path, so the CLI caller
 *   can include it in human-readable output without re-deriving
 *   the same `resolve(MONOREPO_ROOT, ...)` expression.
 * @throws {Error} if any migration fails (prevents service from starting)
 */
export async function runMigrations(): Promise<{ migrationsFolder: string }> {
  const migrationsFolder = resolve(MONOREPO_ROOT, "packages/core/src/db/migrations");
  await migrate(db, { migrationsFolder });
  return { migrationsFolder };
}
