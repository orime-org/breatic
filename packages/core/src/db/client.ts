// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * pool construction is deferred past `initCore` - the same lazy
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
 * factory**, not `postgres(url, ...)` directly - that bypasses the
 * connection-lifecycle configuration that keeps long-running
 * pools from accumulating connections in stale states.
 *
 * Per the CLAUDE.md "industrial-grade server standards" mandate and the
 * 2026-05-27 long-running collab investigation:
 *
 * - `idle_timeout: 30` - close any idle connection after 30s so
 *   the pool can't hold onto a stale connection across long
 *   idle windows;
 * - `max_lifetime: 1800` - recycle every connection after 30 min
 *   regardless of activity, so a slowly-leaking connection
 *   doesn't outlive its safe window;
 * - `max: <pool size>` - caller-supplied;
 *
 * Callers override individual fields via `opts`; the factory
 * spreads `opts` last, so `opts.idle_timeout = 0` (postgres.js
 * docs' recommendation for in-flight-safe behavior) is respected
 * when a caller explicitly opts in. The default policy stays
 * conservative because the long-running drift investigation
 * showed in-flight kills were not observed with the current 30s
 * idle / 30min lifetime values - revisiting the tradeoff is
 * tracked in docs/ROADMAP.md "follow-ups".
 *
 * `name` is required and feeds the postgres.js `connection.
 * application_name` field, which lands in PG's
 * `pg_stat_activity` so DBAs can see which process / pool a
 * connection belongs to without parsing IP / port.
 * @param url - Postgres connection URL
 * @param opts - Per-instance config; `name` is required, the
 *   rest override the production defaults above
 * @returns A configured postgres.js client (`Sql`) with
 *   production-safety defaults applied
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
 * access of `db` / `rawPg` - by then `initCore` has run and
 * `env.DATABASE_URL` resolves. Mirrors `getRedis()`'s lazy pattern.
 */
let _pgClient: Sql | null = null;

/**
 * Build (once) and return the process-wide postgres.js pool.
 * @returns the lazily-initialised postgres.js connection pool
 */
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

/**
 * Build (once) and return the Drizzle ORM instance.
 * @returns the lazily-initialised Drizzle ORM instance over the pool
 */
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
 * Lives in core (the db layer's home) so any repo - in core or in a
 * service package - can type a caller-provided `tx` without importing
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
 * @example
 * ```typescript
 * const result = await rawPg`SELECT 1 AS ok`;
 * ```
 */
export const rawPg: Sql = new Proxy(
  // The Proxy target must be callable to support the `apply` trap
  // (tagged-template usage); the real pool is resolved lazily inside.
  function rawPgTarget() {
    /* never invoked - apply trap forwards to the real pool */
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

/**
 * Liveness ping — `SELECT 1`, true iff the round-trip returns the
 * expected row shape.
 *
 * The single home for the `/healthz` Postgres probe across every
 * backend service (server / worker / collab) so the check can't drift
 * per process. Defaults to the process pool ({@link rawPg}); pass a
 * dedicated `client` for a boot-time fail-fast connectivity check that
 * needs its own short-`connect_timeout`, single-connection pool (so a
 * down PG surfaces at startup instead of waiting on the long-lived
 * pool's defaults).
 * @param client - postgres.js client to ping; defaults to the
 *   process-wide {@link rawPg} pool
 * @returns `true` when `SELECT 1` returns `{ ok: 1 }`
 * @throws {Error} Whatever postgres.js throws when the connection is
 *   unreachable — callers that want fail-fast semantics (boot
 *   connectivity checks) catch it and wrap in `InfraNotReadyError`.
 */
export async function pingDb(client: Sql = rawPg): Promise<boolean> {
  const rows = await client<Array<{ ok: number }>>`SELECT 1 AS ok`;
  return rows[0]?.ok === 1;
}

// ── yjs database (separate Postgres DB for the Yjs binary store) ──────
//
// A SECOND lazy pool, identical in shape to the business `db`/`rawPg`
// above but bound to `env.YJS_DATABASE_URL`. It goes through the SAME
// `createPgClient` factory, so it inherits the same production-grade
// connection-lifecycle defaults — the `lint:no-postgres-outside-core`
// guard stays satisfied (no second `from "postgres"` import). The Yjs
// document store lives in its own database (a separate transaction /
// failure domain); early-stage it may be a second db on the same
// instance, at scale a separate instance — URL-only change.

/** Lazily-built postgres.js pool for the yjs DB. Mirrors {@link _pgClient}. */
let _yjsPgClient: Sql | null = null;

/**
 * Build (once) and return the process-wide yjs-DB postgres.js pool.
 * @returns the lazily-initialised yjs-DB connection pool
 */
function getYjsPgClient(): Sql {
  if (_yjsPgClient === null) {
    _yjsPgClient = createPgClient(env.YJS_DATABASE_URL, {
      name: "core-yjs-db",
      max: env.YJS_DB_POOL_SIZE,
    });
  }
  return _yjsPgClient;
}

/** Lazily-built Drizzle instance over {@link getYjsPgClient}. */
let _yjsDb: PostgresJsDatabase<Record<string, never>> | null = null;

/**
 * Build (once) and return the Drizzle ORM instance for the yjs DB.
 * @returns the lazily-initialised Drizzle ORM instance over the yjs pool
 */
function getYjsDb(): PostgresJsDatabase<Record<string, never>> {
  if (_yjsDb === null) {
    _yjsDb = drizzle(getYjsPgClient());
  }
  return _yjsDb;
}

/**
 * Drizzle ORM instance connected to the yjs PostgreSQL database.
 *
 * A Proxy over the lazily-built {@link getYjsDb} instance, identical in
 * mechanics to {@link db} but resolving against the yjs pool. The yjs
 * document repo (in `@collab`) queries through this so its SQL runs
 * against the yjs DB, not the business DB.
 */
export const yjsDb: PostgresJsDatabase<Record<string, never>> = new Proxy(
  {} as PostgresJsDatabase<Record<string, never>>,
  {
    get(_target, prop) {
      const real = getYjsDb() as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(real)
        : value;
    },
  },
);

/**
 * Transaction handle type for the yjs DB, inferred from
 * {@link yjsDb.transaction}'s callback parameter. The yjs-DB repo uses
 * this for yjs-DB-local transactions; it is a DISTINCT type from
 * {@link DbTx} (a business-DB tx) — the two DBs cannot share a tx.
 */
export type YjsDbTx = Parameters<Parameters<typeof yjsDb.transaction>[0]>[0];

/**
 * Close the yjs database connection pool.
 *
 * Call during graceful shutdown. No-op if the yjs pool was never built.
 */
export async function closeYjsDb(): Promise<void> {
  if (_yjsPgClient !== null) {
    await _yjsPgClient.end();
  }
}

/**
 * Raw postgres.js client for the yjs DB (e.g. health checks). A Proxy
 * over the lazily-built {@link getYjsPgClient} pool, mirroring
 * {@link rawPg}. Pass to {@link pingDb} for the yjs-DB liveness probe.
 */
export const yjsRawPg: Sql = new Proxy(
  function yjsRawPgTarget() {
    /* never invoked - apply trap forwards to the real pool */
  } as unknown as Sql,
  {
    apply(_target, _thisArg, args) {
      return (getYjsPgClient() as unknown as (...a: unknown[]) => unknown)(...args);
    },
    get(_target, prop) {
      const real = getYjsPgClient() as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(real)
        : value;
    },
  },
);
