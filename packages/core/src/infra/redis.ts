/**
 * Redis client singletons (ioredis).
 *
 * Three logical connections, each backed by a separate Redis DB:
 *
 * | Singleton        | ENV Key            | DB  | Purpose                              |
 * |------------------|--------------------|-----|--------------------------------------|
 * | getRedis()       | REDIS_URL          | /0  | Session, lock, rate-limit, health    |
 * | getQueueRedis()  | REDIS_QUEUE_URL    | /1  | BullMQ task queue                    |
 * | getStreamRedis() | REDIS_STREAM_URL   | /2  | Redis Streams + Hocuspocus pub/sub   |
 *
 * Early stage: all three can point to the same Redis instance (different DBs).
 * At scale: swap URLs to independent Redis instances without code changes.
 *
 * All three singletons (and any cross-process consumer such as
 * `dev:collab` / `dev:worker`) go through `createRedisClient` so
 * they inherit the same production-grade defaults (TCP keepalive,
 * commandTimeout, READONLY-aware reconnect, error logging).
 */

import Redis, { type RedisOptions } from "ioredis";
import { env } from "@core/config/env.js";

/**
 * Production-grade ioredis client factory. **Every long-lived
 * ioredis instance in the codebase must go through this factory**,
 * not `new Redis(url)` directly - that bypasses the connection-
 * health configuration that prevents the silent dead-TCP drift
 * documented in
 * [ioredis #139](https://github.com/redis/ioredis/issues/139)
 * (idle connections dropped by an upstream proxy / firewall
 * without notifying the client, leading to multi-minute query
 * stalls or sticky `Unauthorized` errors on Hocuspocus auth).
 *
 * Per the CLAUDE.md "industrial-grade server standards" mandate and the
 * 2026-05-27 long-running drift investigation:
 *
 * - `keepAlive: 30000` - TCP keepalive every 30s so a dropped
 *   midpoint surfaces within seconds, not the ~11 minute OS
 *   default detection window;
 * - `commandTimeout: 5000` - fail a command in 5s instead of
 *   hanging the caller behind a dead socket (BullMQ workers
 *   override to `undefined` because their blocking `BRPOP` runs
 *   longer than any reasonable command timeout);
 * - `connectTimeout: 10000` - bound the initial connect handshake
 *   so app boot doesn't hang on a misconfigured `REDIS_URL`;
 * - `reconnectOnError: (READONLY)` - managed-Redis / Sentinel
 *   failover sends `READONLY` on the old master; reconnect to
 *   land on the new master without a manual restart.
 *
 * Per the "core and shared must not log" mandate (CLAUDE.md
 * "process lifecycle (forbidden in the library layer)") this factory does NOT attach an
 * error logger. A no-op `error` listener is installed so an emitted
 * error doesn't crash the process (ioredis inherits Node's
 * EventEmitter behaviour where an unhandled `error` event is fatal),
 * but the application entry must attach its own listener via
 * `client.on('error', appLogger.error)` to actually log. Multiple
 * `error` listeners are fine - EventEmitter fan-outs to all of them.
 *
 * Callers needing different semantics (BullMQ workers with
 * blocking BRPOP, Hocuspocus extension-redis pub-sub) pass
 * `opts` to override individual fields. `name` is required so the
 * application's own error logger can tag the source.
 * @param url - Redis connection URL (e.g. `redis://localhost:6379/0`)
 * @param opts - Per-instance config; `name` is required, the rest
 *   override the production defaults above
 * @returns A configured ioredis instance with error logging wired up
 * @example
 *   const cache = createRedisClient(env.REDIS_URL, { name: 'cache' });
 *
 *   const worker = createRedisClient(env.REDIS_QUEUE_URL, {
 *     name: 'bullmq-worker',
 *     maxRetriesPerRequest: null, // BullMQ requirement
 *     enableReadyCheck: false,    // BullMQ requirement
 *     commandTimeout: undefined,  // BRPOP exceeds command timeout
 *   });
 */
export function createRedisClient(
  url: string,
  opts: { name: string } & Partial<RedisOptions>,
): Redis {
  const { name: _name, ...override } = opts;
  const client = new Redis(url, {
    keepAlive: 30000,
    commandTimeout: 5000,
    connectTimeout: 10000,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    reconnectOnError(err) {
      // Sentinel / managed-Redis failover: the master was switched
      // and the replica we were holding is now read-only. Returning
      // true reconnects so the next command lands on the new master.
      // Anything else lets ioredis follow its default retry strategy.
      return err.message.includes("READONLY");
    },
    ...override,
  });
  // No-op error listener so an emitted `error` event doesn't crash
  // the process - see the factory doc-comment above. The application
  // entry attaches its own listener for actual logging.
  client.on("error", () => {});
  return client;
}

// ── General (DB 0) ───────────────────────────────────────────────

let _redis: Redis | null = null;

/**
 * Get the general-purpose Redis client (session, lock, rate-limit).
 * @returns The shared ioredis instance for DB 0
 */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = createRedisClient(env.REDIS_URL, { name: "general" });
  }
  return _redis;
}

/**
 * Quit and release the general-purpose Redis client (call on shutdown).
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

// ── Queue (DB 1) ─────────────────────────────────────────────────

let _queueRedis: Redis | null = null;

/**
 * Get the BullMQ Redis client.
 *
 * BullMQ enforces `maxRetriesPerRequest: null` + `enableReadyCheck:
 * false` for any connection passed to a Worker - it throws on
 * startup otherwise (see
 * [bull #2186](https://github.com/OptimalBits/bull/issues/2186)).
 * `commandTimeout` is also disabled because BullMQ workers issue
 * blocking `BRPOP` waits that legitimately exceed any reasonable
 * 5-second timeout.
 * @returns The shared ioredis instance for DB 1
 */
export function getQueueRedis(): Redis {
  if (!_queueRedis) {
    _queueRedis = createRedisClient(env.REDIS_QUEUE_URL, {
      name: "queue",
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      commandTimeout: undefined,
    });
  }
  return _queueRedis;
}

/**
 * Quit and release the BullMQ (DB 1) Redis client (call on shutdown).
 */
export async function closeQueueRedis(): Promise<void> {
  if (_queueRedis) {
    await _queueRedis.quit();
    _queueRedis = null;
  }
}

// ── Stream (DB 2) ────────────────────────────────────────────────

let _streamRedis: Redis | null = null;

/**
 * Get the Streams / Hocuspocus pub-sub Redis client.
 * @returns The shared ioredis instance for DB 2
 */
export function getStreamRedis(): Redis {
  if (!_streamRedis) {
    _streamRedis = createRedisClient(env.REDIS_STREAM_URL, {
      name: "stream",
    });
  }
  return _streamRedis;
}

/**
 * Quit and release the Streams / pub-sub (DB 2) Redis client (call on shutdown).
 */
export async function closeStreamRedis(): Promise<void> {
  if (_streamRedis) {
    await _streamRedis.quit();
    _streamRedis = null;
  }
}

// ── Liveness ─────────────────────────────────────────────────────

/**
 * Liveness ping for a Redis client — true iff `PING` returns `PONG`.
 *
 * The single home for the Redis `/healthz` + boot-connectivity probe so
 * the `=== "PONG"` check can't drift across the ~6 call sites
 * (server / worker / collab health + the connectivity checks). Unlike
 * {@link pingDb} there is NO default client: Redis is multi-connection
 * by role (general / queue / stream / subscriber — each needs its own
 * socket), so the caller passes the specific client it wants to probe.
 * @param client - ioredis client to ping
 * @returns `true` when `PING` returns `"PONG"`
 * @throws {Error} Whatever ioredis throws when the connection is
 *   unreachable — callers that want fail-fast semantics (boot
 *   connectivity checks) catch it and wrap in `InfraNotReadyError`.
 */
export async function pingRedis(client: Redis): Promise<boolean> {
  return (await client.ping()) === "PONG";
}
