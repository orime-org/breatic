// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Cross-instance active-connection registry for the per-document
 * connection cap (#1421).
 *
 * Production runs multiple collab instances behind a load balancer, so
 * Hocuspocus's local `document.getConnectionsCount()` only sees THIS
 * instance's connections — a doc could hold N×cap connections cluster-wide
 * before any instance trips the cap. This registry makes the count
 * authoritative across instances by recording each connection in a Redis
 * sorted set on the collab-coordination DB (`REDIS_COLLAB_URL`, DB3, same
 * connection family as the Hocuspocus pub/sub + the space-delete lock).
 *
 * Data model — one sorted set per document:
 *   key    = `{env}:collab:conncount:{documentName}`
 *   member = `{instanceId}:{socketId}`  (unique per connection cluster-wide)
 *   score  = epoch ms of the member's last heartbeat
 *
 * Lifecycle: `register` on connect (ZADD), `unregister` on clean disconnect
 * (ZREM), a per-instance `heartbeat` timer refreshes every live member's
 * score. `count` prunes members whose score is older than the TTL, then
 * returns the survivors. A crashed instance stops heartbeating, so its
 * members fall out of the TTL window and are pruned automatically — no
 * cleanup job, no zombie count (the industrial TTL-heartbeat pattern).
 *
 * PRECISION vs the physical floor: clean connect / disconnect are reflected
 * immediately (ZADD / ZREM). Only a CRASH lags — a crashed connection
 * lingers up to one TTL window, because no distributed system can know a
 * connection died without a timeout. This is the most-precise-achievable
 * cross-instance count.
 *
 * FAIL-OPEN: every Redis call is best-effort. The cap is a soft protection
 * (over-cap connections degrade to read-only, they are not rejected), so a
 * Redis outage must NOT lock everyone out — `count` returns 0 on error
 * (nobody degraded) and register / unregister / heartbeat swallow errors.
 *
 * Meta-doc exemption is the CALLER's policy (the auth hook / hocuspocus
 * wiring skip meta docs), not this module's — this is a pure counter.
 */
import { env, type Redis } from "@breatic/core";
import { createLogger } from "@breatic/core";

const logger = createLogger("conn-registry");

/** Default staleness window (ms): a member unrefreshed this long is pruned. */
const DEFAULT_TTL_MS = 30_000;
/** Default heartbeat period (ms): must be well under {@link DEFAULT_TTL_MS}. */
const DEFAULT_HEARTBEAT_MS = 10_000;

/** Options for {@link createConnectionRegistry}. */
export interface ConnectionRegistryOptions {
  /** Collab-coordination Redis (DB3). */
  redis: Redis;
  /** Unique id of this collab process (namespaces members cluster-wide). */
  instanceId: string;
  /** Staleness window in ms (default 30_000). */
  ttlMs?: number;
  /** Heartbeat period in ms (default 10_000). */
  heartbeatMs?: number;
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number;
  /** Key builder, injectable for tests (default `{env}:collab:conncount:{doc}`). */
  keyFor?: (documentName: string) => string;
}

/** Cross-instance connection registry (see module doc). */
export interface ConnectionRegistry {
  /**
   * Record a connection to `documentName` from this instance.
   * @param documentName - Hocuspocus document the socket attached to.
   * @param socketId - Hocuspocus socket id (unique within this instance).
   * @returns once the ZADD has been attempted (best-effort / fail-open).
   */
  register(documentName: string, socketId: string): Promise<void>;
  /**
   * Remove a cleanly-disconnected connection.
   * @param documentName - Document the socket was attached to.
   * @param socketId - Socket id to remove.
   * @returns once the ZREM has been attempted (best-effort / fail-open).
   */
  unregister(documentName: string, socketId: string): Promise<void>;
  /**
   * Cluster-wide live connection count for `documentName` (prunes stale
   * members first). Returns 0 on any Redis error (fail-open).
   * @param documentName - Document to count.
   * @returns the number of live connections cluster-wide.
   */
  count(documentName: string): Promise<number>;
  /**
   * Refresh the score of every live member owned by this instance.
   * @returns once every refresh has been attempted (best-effort / fail-open).
   */
  heartbeat(): Promise<void>;
  /** Start the heartbeat timer (idempotent). */
  start(): void;
  /** Stop the heartbeat timer. */
  stop(): void;
}

/**
 * Build a cross-instance connection registry over the given Redis.
 * @param options - See {@link ConnectionRegistryOptions}.
 * @returns a {@link ConnectionRegistry}.
 */
export function createConnectionRegistry(
  options: ConnectionRegistryOptions,
): ConnectionRegistry {
  const {
    redis,
    instanceId,
    ttlMs = DEFAULT_TTL_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    now = Date.now,
    keyFor = (documentName: string): string =>
      `${env.ENV}:collab:conncount:${documentName}`,
  } = options;

  // documentName -> set of THIS instance's live socketIds (for heartbeat).
  const local = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Cluster-wide member id for a socket on this instance.
   * @param socketId - Hocuspocus socket id.
   * @returns `{instanceId}:{socketId}`.
   */
  const member = (socketId: string): string => `${instanceId}:${socketId}`;

  /**
   * Cap the key's own TTL so a doc whose every connection dies does not
   * leave an empty set forever (no un-TTL'd keys — project Redis rule).
   * @param documentName - Document whose key to expire.
   * @returns once EXPIRE has been attempted.
   */
  async function touchKeyTtl(documentName: string): Promise<void> {
    await redis.expire(keyFor(documentName), Math.ceil((ttlMs * 2) / 1000));
  }

  /**
   * Register a connection: ZADD to the doc's sorted set + refresh the key TTL.
   * @param documentName - Document the socket attached to.
   * @param socketId - Socket id.
   * @returns once attempted (fail-open).
   */
  async function register(
    documentName: string,
    socketId: string,
  ): Promise<void> {
    let set = local.get(documentName);
    if (!set) {
      set = new Set();
      local.set(documentName, set);
    }
    set.add(socketId);
    try {
      await redis.zadd(keyFor(documentName), now(), member(socketId));
      await touchKeyTtl(documentName);
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_register_failed" },
        "connection-registry register failed (fail-open)",
      );
    }
  }

  /**
   * Remove a cleanly-disconnected connection: ZREM from the doc's sorted set.
   * @param documentName - Document the socket was attached to.
   * @param socketId - Socket id to remove.
   * @returns once attempted (fail-open).
   */
  async function unregister(
    documentName: string,
    socketId: string,
  ): Promise<void> {
    const set = local.get(documentName);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) local.delete(documentName);
    }
    try {
      await redis.zrem(keyFor(documentName), member(socketId));
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_unregister_failed" },
        "connection-registry unregister failed (fail-open)",
      );
    }
  }

  /**
   * Prune stale members, then return the doc's surviving member count.
   * @param documentName - Document to count.
   * @returns cluster-wide live connection count (0 on Redis error).
   */
  async function count(documentName: string): Promise<number> {
    try {
      const cutoff = now() - ttlMs;
      await redis.zremrangebyscore(keyFor(documentName), "-inf", cutoff);
      return await redis.zcard(keyFor(documentName));
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_count_failed" },
        "connection-registry count failed (fail-open → 0)",
      );
      return 0;
    }
  }

  /**
   * Refresh every live member owned by this instance to `now`, so they
   * survive pruning while the connection is alive.
   * @returns once all refreshes have been attempted (fail-open per doc).
   */
  async function heartbeat(): Promise<void> {
    const t = now();
    for (const [documentName, set] of local) {
      try {
        for (const socketId of set) {
          await redis.zadd(keyFor(documentName), t, member(socketId));
        }
        await touchKeyTtl(documentName);
      } catch (err) {
        logger.warn(
          { err, documentName, tag: "conn_registry_heartbeat_failed" },
          "connection-registry heartbeat failed (fail-open)",
        );
      }
    }
  }

  /** Start the heartbeat timer once (idempotent — a second call is a no-op). */
  function start(): void {
    if (timer) return;
    timer = setInterval(() => void heartbeat(), heartbeatMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  /** Stop the heartbeat timer (safe to call when not started). */
  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { register, unregister, count, heartbeat, start, stop };
}
