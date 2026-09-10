// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-instance seat registry for the per-document connection cap (#1421).
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
 *   member = `{userId}:{connectedAtMs}:{instanceId}:{socketId}`
 *   score  = epoch ms this connection last answered a ping
 *
 * The member carries who holds the seat and when the connection was
 * established because the handshake needs both: it has to find the arriving
 * person's OWN seats, and among those pick the one to take. The score cannot
 * answer the second question — two live connections on one instance are
 * refreshed by the same pong loop and differ by an event-loop turn.
 *
 * TWO OBJECTS, TWO SIGNALS. A member's score moves when its connection
 * answers a ping: that is the client saying it is still there, and it is the
 * only thing that says so. The KEY's own TTL is a different matter — it is
 * this process saying it still exists — so an instance-level timer renews the
 * keys and never touches a member's score. Collapsing the two is what made
 * the predecessor refresh seats whose socket had been gone for a minute.
 *
 * FAIL-OPEN: every Redis call is best-effort. The cap is a soft protection
 * (over-cap connections degrade to read-only, they are not rejected), so a
 * Redis outage must NOT lock everyone out — `count` returns 0 on error
 * (nobody degraded) and the write paths swallow errors.
 *
 * Meta-doc exemption is the CALLER's policy (the auth hook / hocuspocus
 * wiring skip meta docs), not this module's — this is a pure counter.
 */
import { env, type Redis } from "@breatic/core";
import { createLogger } from "@breatic/core";

const logger = createLogger("conn-registry");

/** How often the instance renews its keys' TTL, relative to the ping period. */
const KEY_TOUCH_DIVISOR = 3;

/** Who holds a seat, and when their connection was established. */
export interface SeatHolder {
  /** Hocuspocus socket id (unique within this instance). */
  socketId: string;
  /** The authenticated user this connection belongs to. */
  userId: string;
  /** Epoch ms the connection was established. */
  connectedAtMs: number;
}

/** Options for {@link createConnectionRegistry}. */
export interface ConnectionRegistryOptions {
  /** Collab-coordination Redis (DB3). */
  redis: Redis;
  /** Unique id of this collab process (namespaces members cluster-wide). */
  instanceId: string;
  /** How often the transport pings each connection, in ms. */
  pingIntervalMs: number;
  /** How long a seat is believed once it stops being refreshed, in ms. */
  seatExpiryMs: number;
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number;
  /** Key builder, injectable for tests (default `{env}:collab:conncount:{doc}`). */
  keyFor?: (documentName: string) => string;
}

/** Cross-instance seat registry (see module doc). */
export interface ConnectionRegistry {
  /**
   * Record a connection's seat on `documentName`.
   * @param documentName - Hocuspocus document the socket attached to.
   * @param holder - Who is connecting, and when they connected.
   * @returns once the ZADD has been attempted (best-effort / fail-open).
   */
  register(documentName: string, holder: SeatHolder): Promise<void>;
  /**
   * Release a cleanly-disconnected connection's seat.
   * @param documentName - Document the socket was attached to.
   * @param socketId - Socket id whose seat to release.
   * @returns once the ZREM has been attempted (best-effort / fail-open).
   */
  unregister(documentName: string, socketId: string): Promise<void>;
  /**
   * Move every seat this socket holds forward to now, because it just
   * answered a ping.
   * @param socketId - The socket that answered.
   * @returns once every refresh has been attempted (best-effort / fail-open).
   */
  refreshSocket(socketId: string): Promise<void>;
  /**
   * Take one of `userId`'s own seats on `documentName` so an arriving
   * connection of theirs can have it.
   * @param documentName - Document that is at capacity.
   * @param userId - The person arriving.
   * @returns The member actually removed, or null when they hold no seat here
   *   or another handshake removed every candidate first.
   */
  claimSeatFrom(
    documentName: string,
    userId: string,
  ): Promise<string | null>;
  /**
   * Stop refreshing a seat this instance no longer holds, because the
   * connection was demoted to read-only and the seat has gone to somebody
   * else's connection.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was claimed.
   * @returns Nothing.
   */
  forgetSeat(documentName: string, member: string): void;
  /**
   * Cluster-wide live connection count for `documentName` (prunes stale
   * members first). Returns 0 on any Redis error (fail-open).
   * @param documentName - Document to count.
   * @returns the number of live connections cluster-wide.
   */
  count(documentName: string): Promise<number>;
  /**
   * Renew the TTL of every key this instance holds a seat in, without moving
   * any member's score.
   * @returns once every renewal has been attempted (best-effort / fail-open).
   */
  touchKeys(): Promise<void>;
  /** Start the key-renewal timer (idempotent). */
  start(): void;
  /** Stop the key-renewal timer. */
  stop(): void;
}

/**
 * Build a cross-instance seat registry over the given Redis.
 * @param options - See {@link ConnectionRegistryOptions}.
 * @returns a {@link ConnectionRegistry}.
 */
export function createConnectionRegistry(
  options: ConnectionRegistryOptions,
): ConnectionRegistry {
  const {
    redis,
    instanceId,
    pingIntervalMs,
    seatExpiryMs,
    now = Date.now,
    keyFor = (documentName: string): string =>
      `${env.ENV}:collab:conncount:${documentName}`,
  } = options;

  // socketId -> documentName -> the member string this instance wrote. The
  // member is stored rather than rebuilt because `connectedAtMs` is minted at
  // register time and nothing downstream carries it: `onDisconnect` gets a
  // socket id and nothing else.
  const bySocket = new Map<string, Map<string, string>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * The member string for one seat.
   * @param holder - Who is connecting, and when.
   * @returns `{userId}:{connectedAtMs}:{instanceId}:{socketId}`.
   */
  function memberFor(holder: SeatHolder): string {
    return `${holder.userId}:${holder.connectedAtMs}:${instanceId}:${holder.socketId}`;
  }

  /**
   * Cap the key's own TTL so a doc whose every connection dies does not leave
   * an empty set forever (no un-TTL'd keys — project Redis rule).
   * @param documentName - Document whose key to expire.
   * @returns once EXPIRE has been attempted.
   */
  async function touchKeyTtl(documentName: string): Promise<void> {
    await redis.expire(keyFor(documentName), Math.ceil((seatExpiryMs * 2) / 1000));
  }

  /**
   * Record a seat: ZADD to the doc's sorted set + refresh the key TTL.
   * @param documentName - Document the socket attached to.
   * @param holder - Who is connecting, and when.
   * @returns once attempted (fail-open).
   */
  async function register(
    documentName: string,
    holder: SeatHolder,
  ): Promise<void> {
    const member = memberFor(holder);
    let seats = bySocket.get(holder.socketId);
    if (!seats) {
      seats = new Map();
      bySocket.set(holder.socketId, seats);
    }
    seats.set(documentName, member);
    try {
      await redis.zadd(keyFor(documentName), now(), member);
      await touchKeyTtl(documentName);
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_register_failed" },
        "connection-registry register failed (fail-open)",
      );
    }
  }

  /**
   * Release a seat: ZREM the member this instance wrote for that socket.
   * @param documentName - Document the socket was attached to.
   * @param socketId - Socket id whose seat to release.
   * @returns once attempted (fail-open).
   */
  async function unregister(
    documentName: string,
    socketId: string,
  ): Promise<void> {
    const seats = bySocket.get(socketId);
    const member = seats?.get(documentName);
    if (seats) {
      seats.delete(documentName);
      if (seats.size === 0) bySocket.delete(socketId);
    }
    if (member === undefined) return;
    try {
      await redis.zrem(keyFor(documentName), member);
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_unregister_failed" },
        "connection-registry unregister failed (fail-open)",
      );
    }
  }

  /**
   * Move every seat this socket holds forward, on the strength of its pong.
   * @param socketId - The socket that answered.
   * @returns once attempted (fail-open per document).
   */
  async function refreshSocket(socketId: string): Promise<void> {
    const seats = bySocket.get(socketId);
    if (!seats) return;
    const t = now();
    for (const [documentName, member] of seats) {
      try {
        await redis.zadd(keyFor(documentName), t, member);
        await touchKeyTtl(documentName);
      } catch (err) {
        logger.warn(
          { err, documentName, tag: "conn_registry_refresh_failed" },
          "connection-registry refresh failed (fail-open)",
        );
      }
    }
  }

  /**
   * Order this person's seats by which one to take first.
   *
   * A seat whose score has not moved in over a ping period is first: its
   * connection has stopped answering, so taking it costs nothing. That case
   * is the reconnect — the arriving person's own blip left a seat behind, and
   * ordering by age alone would take the tab they are still using instead.
   * Among seats that are all answering, the oldest connection goes.
   * @param entries - Member strings with their scores, this person's only.
   * @param t - Now.
   * @returns The members, best candidate first.
   */
  function orderCandidates(
    entries: { member: string; score: number }[],
    t: number,
  ): string[] {
    const silentBefore = t - pingIntervalMs;
    return [...entries]
      .sort((a, b) => {
        const aSilent = a.score < silentBefore ? 0 : 1;
        const bSilent = b.score < silentBefore ? 0 : 1;
        if (aSilent !== bSilent) return aSilent - bSilent;
        return connectedAtOf(a.member) - connectedAtOf(b.member);
      })
      .map((e) => e.member);
  }

  /**
   * The moment a member's connection was established.
   * @param member - A member string.
   * @returns Its `connectedAtMs` segment, or Infinity when unparseable so a
   *   malformed member sorts last rather than being taken first.
   */
  function connectedAtOf(member: string): number {
    const at = Number(member.split(":")[1]);
    return Number.isFinite(at) ? at : Infinity;
  }

  /**
   * The user a member belongs to.
   * @param member - A member string.
   * @returns Its `userId` segment.
   */
  function userIdOf(member: string): string {
    return member.split(":")[0] ?? "";
  }

  /**
   * Take one of this person's own seats, cluster-wide.
   *
   * ZREM's return value is the claim: it says how many members were actually
   * removed, so only the caller that got 1 may treat the seat as the one it
   * freed. A 0 means another handshake removed that candidate a moment
   * earlier, and the next candidate is tried.
   * @param documentName - Document that is at capacity.
   * @param userId - The person arriving.
   * @returns The member removed, or null.
   */
  async function claimSeatFrom(
    documentName: string,
    userId: string,
  ): Promise<string | null> {
    try {
      const raw = await redis.zrange(
        keyFor(documentName),
        0,
        -1,
        "WITHSCORES",
      );
      const mine: { member: string; score: number }[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        const member = raw[i];
        const score = Number(raw[i + 1]);
        if (member === undefined) continue;
        if (userIdOf(member) !== userId) continue;
        mine.push({ member, score });
      }
      for (const member of orderCandidates(mine, now())) {
        const removed = await redis.zrem(keyFor(documentName), member);
        if (removed > 0) return member;
      }
      return null;
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_claim_failed" },
        "connection-registry claim failed (fail-open → no handover)",
      );
      return null;
    }
  }

  /**
   * Drop a seat from this instance's bookkeeping without touching Redis.
   *
   * The seat is already gone — the arriving handshake removed it. What is
   * left is to stop the pong loop writing it back, which would leave a
   * read-only connection holding a seat that never comes free again.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was claimed.
   */
  function forgetSeat(documentName: string, member: string): void {
    for (const [socketId, seats] of bySocket) {
      if (seats.get(documentName) !== member) continue;
      seats.delete(documentName);
      if (seats.size === 0) bySocket.delete(socketId);
      break;
    }
  }

  /**
   * Prune stale members, then return the doc's surviving member count.
   * @param documentName - Document to count.
   * @returns cluster-wide live connection count (0 on Redis error).
   */
  async function count(documentName: string): Promise<number> {
    try {
      const cutoff = now() - seatExpiryMs;
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
   * Renew every key this instance has a seat in.
   *
   * This says "the process is still here", which is a different claim from
   * "the connection is still here" — so it renews the key and leaves every
   * member's score exactly where its own pong put it.
   * @returns once every renewal has been attempted (fail-open per document).
   */
  async function touchKeys(): Promise<void> {
    const documents = new Set<string>();
    for (const seats of bySocket.values()) {
      for (const documentName of seats.keys()) documents.add(documentName);
    }
    for (const documentName of documents) {
      try {
        await touchKeyTtl(documentName);
      } catch (err) {
        logger.warn(
          { err, documentName, tag: "conn_registry_touch_keys_failed" },
          "connection-registry key renewal failed (fail-open)",
        );
      }
    }
  }

  /** Start the key-renewal timer once (idempotent — a second call is a no-op). */
  function start(): void {
    if (timer) return;
    timer = setInterval(
      () => void touchKeys(),
      Math.max(1, Math.floor(pingIntervalMs / KEY_TOUCH_DIVISOR)),
    );
    if (typeof timer.unref === "function") timer.unref();
  }

  /** Stop the key-renewal timer (safe to call when not started). */
  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    register,
    unregister,
    refreshSocket,
    claimSeatFrom,
    forgetSeat,
    count,
    touchKeys,
    start,
    stop,
  };
}
