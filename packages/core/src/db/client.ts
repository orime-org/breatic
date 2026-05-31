/**
 * PostgreSQL database client using postgres.js + Drizzle ORM.
 *
 * Exposes a **lazy** singleton connection pool for the server /
 * worker process via `db` / `rawPg`. "Lazy" because the pool is
 * built on first access, not at module import: `@breatic/core` no
 * longer reads `process.env` at import time, so the connection URL
 * (`env.DATABASE_URL`) is only available after the application
 * entry has run `initCore(process.env)`. `db` / `rawPg` are Proxies
 * that resolve against the lazily-built pool at access time, so the
 * ~25 `db.select()` / `rawPg` call sites stay unchanged while the
 * pool construction is deferred past `initCore` — the same lazy
 * pattern `getRedis()` already uses for the Redis clients.
 *
 * Cross-process consumers (collab is a separate Node process and
 * can't share this singleton instance) call {@link createPgClient}
 * to get a configured postgres.js client that inherits the same
 * production-safety defaults (idle_timeout / max_lifetime / max
 * pool size) so connection lifecycle behaves the same way across
 * all server-side processes.
 *
 * Use {@link closeDb} for graceful shutdown.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
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

/**
 * Lazily-built postgres.js pool for this process. Null until first
 * access of `db` / `rawPg` — by then `initCore` has run and
 * `env.DATABASE_URL` resolves. Mirrors `getRedis()`'s lazy pattern.
 */
let _pgClient: Sql | null = null;

/** Build (once) and return the process-wide postgres.js pool. */
function getPgClient(): Sql {
  if (_pgClient === null) {
    _pgClient = createPgClient(env.DATABASE_URL, {
      name: "core-db",
      max: env.DB_POOL_SIZE,
    });
  }
  return _pgClient;
}

/** Lazily-built Drizzle instance over {@link getPgClient}. */
let _db: PostgresJsDatabase<Record<string, never>> | null = null;

/** Build (once) and return the Drizzle ORM instance. */
function getDb(): PostgresJsDatabase<Record<string, never>> {
  if (_db === null) {
    _db = drizzle(getPgClient());
  }
  return _db;
}

/**
 * Drizzle ORM instance connected to PostgreSQL.
 *
 * A Proxy over the lazily-built {@link getDb} instance: property
 * access resolves against the real Drizzle object at call time
 * (built on first use, after `initCore`). Methods are bound to the
 * real instance so Drizzle's internal `this` is preserved.
 */
export const db: PostgresJsDatabase<Record<string, never>> = new Proxy(
  {} as PostgresJsDatabase<Record<string, never>>,
  {
    get(_target, prop) {
      const real = getDb() as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(real)
        : value;
    },
  },
);

/**
 * Transaction handle type, inferred from {@link db.transaction}'s
 * callback parameter.
 *
 * Lives in core (the db layer's home) so any repo — in core or in a
 * service package — can type a caller-provided `tx` without importing
 * a sibling repo just for the type. Repos that accept an optional
 * `tx` use this to let the caller compose several writes across one
 * transaction (e.g. project creation + owner-member insert) without
 * the repo owning its own transaction.
 */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Close the database connection pool.
 *
 * Call during graceful shutdown to drain pending queries. No-op if
 * the pool was never built (nothing was ever queried).
 */
export async function closeDb(): Promise<void> {
  if (_pgClient !== null) {
    await _pgClient.end();
  }
}

/**
 * Raw postgres.js client for direct queries (e.g. health checks).
 *
 * A Proxy over the lazily-built {@link getPgClient} pool. postgres.js
 * clients are callable (tagged-template) AND have methods, so the
 * Proxy forwards both `apply` (the tagged-template call) and `get`
 * (`.end()`, etc.) to the real pool.
 *
 * @example
 * ```typescript
 * const result = await rawPg`SELECT 1 AS ok`;
 * ```
 */
export const rawPg: Sql = new Proxy(
  // The Proxy target must be callable to support the `apply` trap
  // (tagged-template usage); the real pool is resolved lazily inside.
  function rawPgTarget() {
    /* never invoked — apply trap forwards to the real pool */
  } as unknown as Sql,
  {
    apply(_target, _thisArg, args) {
      return (getPgClient() as unknown as (...a: unknown[]) => unknown)(...args);
    },
    get(_target, prop) {
      const real = getPgClient() as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(real)
        : value;
    },
  },
);
