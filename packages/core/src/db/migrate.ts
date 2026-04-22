/**
 * Programmatic database migration using Drizzle ORM.
 *
 * Runs all pending SQL migrations from the `migrations/` directory.
 * Called at startup by both the API server and Worker to ensure
 * the schema is always up-to-date before serving requests.
 *
 * Safe to call concurrently — Drizzle uses a lock table to prevent
 * duplicate migration runs.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import { db } from "./client.js";
import { logger } from "../logger.js";
import { MONOREPO_ROOT } from "../config/env.js";

/**
 * Run all pending database migrations.
 *
 * @throws Error if any migration fails (prevents service from starting)
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = resolve(MONOREPO_ROOT, "packages/core/src/db/migrations");
  logger.info({ migrationsFolder }, "Running database migrations...");

  await migrate(db, { migrationsFolder });

  logger.info("Database migrations completed");
}
