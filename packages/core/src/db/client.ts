/**
 * PostgreSQL database client using postgres.js + Drizzle ORM.
 *
 * Creates a singleton connection pool. Use {@link closeDb} for
 * graceful shutdown.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";

const pgClient = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_SIZE,
  idle_timeout: 30,
  max_lifetime: 60 * 30,
});

/** Drizzle ORM instance connected to PostgreSQL. */
export const db = drizzle(pgClient);

/**
 * Close the database connection pool.
 *
 * Call during graceful shutdown to drain pending queries.
 */
export async function closeDb(): Promise<void> {
  await pgClient.end();
}

/**
 * Raw postgres.js client for direct queries (e.g. health checks).
 *
 * @example
 * ```typescript
 * const result = await rawPg`SELECT 1 AS ok`;
 * ```
 */
export const rawPg = pgClient;
