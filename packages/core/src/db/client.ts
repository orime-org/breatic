/**
 * PostgreSQL database client using postgres.js + Drizzle ORM.
 *
 * Creates a singleton connection pool for the server / worker
 * process via `db` / `rawPg`. Cross-process consumers (collab is
 * a separate Node process and can't share this singleton instance)
 * call {@link createPgClient} to get a configured postgres.js
 * client that inherits the same production-safety defaults
 * (idle_timeout / max_lifetime / max pool size) so connection
 * lifecycle behaves the same way across all server-side
 * processes.
 *
 * Use {@link closeDb} for graceful shutdown.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Options, type Sql } from "postgres";
import { env } from "@core/config/env.js";

/**
 * Production-grade postgres.js client factory. **Every long-lived
 * postgres.js client in the codebase must go through this
 * factory**, not `postgres(url, ...)` directly — that bypasses the
 * connection-lifecycle configuration that keeps long-running
 * pools from accumulating connections in stale states.
 *
 * Per the CLAUDE.md "服务器端工业级标准" mandate and the
 * 2026-05-27 long-running collab investigation:
 *
 * - `idle_timeout: 30` — close any idle connection after 30s so
 *   the pool can't hold onto a stale connection across long
 *   idle windows;
 * - `max_lifetime: 1800` — recycle every connection after 30 min
 *   regardless of activity, so a slowly-leaking connection
 *   doesn't outlive its safe window;
 * - `max: <pool size>` — caller-supplied;
 *
 * Callers override individual fields via `opts`; the factory
 * spreads `opts` last, so `opts.idle_timeout = 0` (postgres.js
 * docs' recommendation for in-flight-safe behavior) is respected
 * when a caller explicitly opts in. The default policy stays
 * conservative because the long-running drift investigation
 * showed in-flight kills were not observed with the current 30s
 * idle / 30min lifetime values — revisiting the tradeoff is
 * tracked in docs/ROADMAP.md "待跟进".
 *
 * `name` is required and feeds the postgres.js `connection.
 * application_name` field, which lands in PG's
 * `pg_stat_activity` so DBAs can see which process / pool a
 * connection belongs to without parsing IP / port.
 *
 * @param url - Postgres connection URL
 * @param opts - Per-instance config; `name` is required, the
 *   rest override the production defaults above
 * @returns A configured postgres.js client (`Sql`) with
 *   production-safety defaults applied
 *
 * @example
 *   const sql = createPgClient(env.DATABASE_URL, {
 *     name: 'collab-auth',
 *     max: 5,
 *   });
 */
export function createPgClient(
  url: string,
  opts: { name: string } & Options<Record<string, never>>,
): Sql {
  const { name, ...override } = opts;
  return postgres(url, {
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connection: { application_name: name },
    ...override,
  });
}

const pgClient = createPgClient(env.DATABASE_URL, {
  name: "core-db",
  max: env.DB_POOL_SIZE,
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
