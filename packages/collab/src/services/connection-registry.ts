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
 *   key    = `{env}:collab:seats:{documentName}`
 *   member = `{userId}:{connectedAtMs}:{instanceId}:{socketId}`
 *   score  = epoch ms this connection last answered a ping
 *
 * The member carries who holds the seat and when the connection was
 * established because the handshake needs both: it has to find the arriving
 * person's OWN seats, and among those pick the one to take. The score cannot
 * answer the second question — two live connections on one instance are
 * refreshed by the same pong loop and differ by an event-loop turn.
 *
 * A member's score moves when its connection answers a ping: that is the
 * client saying it is still there, and it is the only thing that says so.
 * Nothing else writes a score — the predecessor had a timer that refreshed
 * every member unconditionally, which kept seats alive whose socket had been
 * gone for a minute. The key's own TTL rides along with each of those writes,
 * so a key lives exactly as long as some member in it is still answering.
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

/** The four things a member string carries, once taken apart. */
export interface SeatMember {
  /** The authenticated user holding the seat. */
  userId: string;
  /** Epoch ms their connection was established. */
  connectedAtMs: number;
  /** The instance holding it. */
  instanceId: string;
  /** The socket it arrived on. */
  socketId: string;
}

/**
 * Take a member string apart.
 *
 * Lives next to the one function that builds them, and is the only way to
 * read one: three readers used to derive the format by hand, each with its
 * own idea of what counts as malformed, so a change to the format would have
 * left some of them working and the rest silently doing nothing.
 * @param member - A member string as stored in the sorted set.
 * @returns Its four parts, or null when it is not one of ours.
 */
export function parseSeatMember(member: string): SeatMember | null {
  const parts = member.split(":");
  if (parts.length !== 4) return null;
  const [userId, at, instanceId, socketId] = parts as [
    string,
    string,
    string,
    string,
  ];
  const connectedAtMs = Number(at);
  if (!Number.isFinite(connectedAtMs)) return null;
  return { userId, connectedAtMs, instanceId, socketId };
}

/** What a handover attempt found. */
export type SeatClaim =
  /** One of this person's seats was taken; it is theirs to replace. */
  | { outcome: "took"; member: string }
  /** This person holds no seat on this document. */
  | { outcome: "none" }
  /** Redis could not answer. Nothing was taken and nothing is known. */
  | { outcome: "unknown" };

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
  /** Key builder, injectable for tests (default `{env}:collab:seats:{doc}`). */
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
   * @returns `took` with the member removed, `none` when they hold no seat
   *   here or another handshake removed every candidate first, or `unknown`
   *   when Redis could not answer.
   */
  claimSeatFrom(documentName: string, userId: string): Promise<SeatClaim>;
  /**
   * Let go of a seat this instance no longer holds, because the connection
   * was demoted to read-only and the seat has gone to somebody else's
   * connection. Removes the member from Redis as well as from this
   * instance's bookkeeping.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was claimed.
   * @returns once attempted (fail-open).
   */
  forgetSeat(documentName: string, member: string): Promise<void>;
  /**
   * Cluster-wide live connection count for `documentName` (prunes stale
   * members first). Returns 0 on any Redis error (fail-open).
   * @param documentName - Document to count.
   * @returns the number of live connections cluster-wide.
   */
  count(documentName: string): Promise<number>;
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
      `${env.ENV}:collab:seats:${documentName}`,
  } = options;

  // socketId -> documentName -> the member string this instance wrote. The
  // member is stored rather than rebuilt because `connectedAtMs` is minted at
  // register time and nothing downstream carries it: `onDisconnect` gets a
  // socket id and nothing else.
  const bySocket = new Map<string, Map<string, string>>();

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
   * Write one member's score, and renew the key it lives in.
   *
   * The only thing here that calls ZADD. A key with no TTL outlives the
   * process that made it, and a key that expires between two renewals takes
   * every seat on that document with it — both silent, because `count()` just
   * answers a number. Pairing the two by hand at each write site is a rule
   * somebody has to remember; pairing them here is one nobody can miss.
   * @param documentName - Document whose set to write to.
   * @param member - The member string.
   * @param score - Epoch ms to store as its score.
   * @returns once both have been attempted.
   */
  async function writeSeat(
    documentName: string,
    member: string,
    score: number,
  ): Promise<void> {
    await redis.zadd(keyFor(documentName), score, member);
    await touchKeyTtl(documentName);
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
      await writeSeat(documentName, member, now());
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
        await writeSeat(documentName, member, t);
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
   * A seat whose score has stopped moving is first: its connection is not
   * answering, so taking it costs nothing. That case is the reconnect — the
   * arriving person's own blip left a seat behind, and ordering by age alone
   * would take the tab they are still using instead.
   * Among seats that are all answering, the oldest connection goes.
   *
   * The boundary sits between one ping period and the seat expiry, not on
   * either of them. A live seat's score is rewritten once per period, so just
   * before each refresh a healthy seat is one full period stale — plus the
   * interval firing late, the round trip, and whatever two instances' clocks
   * disagree by. Below that ceiling the first tier fires on the tab the
   * member is using; at the expiry there is no seat left to find.
   * @param entries - Member strings with their scores, this person's only.
   * @param t - Now.
   * @returns The members, best candidate first.
   */
  function orderCandidates(
    entries: { member: string; parsed: SeatMember; score: number }[],
    t: number,
  ): string[] {
    const silentBefore = t - (pingIntervalMs + seatExpiryMs) / 2;
    return [...entries]
      .sort((a, b) => {
        const aSilent = a.score < silentBefore ? 0 : 1;
        const bSilent = b.score < silentBefore ? 0 : 1;
        if (aSilent !== bSilent) return aSilent - bSilent;
        return a.parsed.connectedAtMs - b.parsed.connectedAtMs;
      })
      .map((e) => e.member);
  }

  /**
   * Take one of this person's own seats, cluster-wide.
   *
   * ZREM's return value is the claim: it says how many members were actually
   * removed, so only the caller that got 1 may treat the seat as the one it
   * freed. A 0 means another handshake removed that candidate a moment
   * earlier, and the next candidate is tried.
   * "Found nothing" and "could not find out" are separate answers. This is
   * what decides whether an arriving connection can write, so reporting the
   * second as the first would pin somebody read-only on their own second tab
   * over a single failed command — the one thing the handover exists to
   * prevent, and the opposite of how every other path here treats Redis.
   * @param documentName - Document that is at capacity.
   * @param userId - The person arriving.
   * @returns What was found: a seat taken, none held, or nothing known.
   */
  async function claimSeatFrom(
    documentName: string,
    userId: string,
  ): Promise<SeatClaim> {
    try {
      const raw = await redis.zrange(
        keyFor(documentName),
        0,
        -1,
        "WITHSCORES",
      );
      const mine: { member: string; parsed: SeatMember; score: number }[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        const member = raw[i];
        const score = Number(raw[i + 1]);
        if (member === undefined) continue;
        const parsed = parseSeatMember(member);
        if (parsed === null || parsed.userId !== userId) continue;
        mine.push({ member, parsed, score });
      }
      for (const member of orderCandidates(mine, now())) {
        const removed = await redis.zrem(keyFor(documentName), member);
        if (removed > 0) return { outcome: "took", member };
      }
      return { outcome: "none" };
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_claim_failed" },
        "connection-registry claim failed (fail-open → capacity unknown)",
      );
      return { outcome: "unknown" };
    }
  }

  /**
   * Let go of a seat that has been handed to an arriving connection.
   *
   * Two things, and both are needed. The member comes out of Redis: the
   * arriving handshake already removed it, but the claim and the demote sit
   * on opposite sides of a document load and a pub/sub round trip, and a pong
   * landing in that window writes it straight back. And it comes out of this
   * instance's map, so the pong loop stops touching it — otherwise a
   * read-only connection would hold a seat that never comes free again.
   *
   * Removing a member that is already gone is a no-op, so the ordinary case
   * where no pong intervened costs one command and changes nothing.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was claimed.
   * @returns once attempted (fail-open).
   */
  async function forgetSeat(
    documentName: string,
    member: string,
  ): Promise<void> {
    for (const [socketId, seats] of bySocket) {
      if (seats.get(documentName) !== member) continue;
      seats.delete(documentName);
      if (seats.size === 0) bySocket.delete(socketId);
      break;
    }
    try {
      await redis.zrem(keyFor(documentName), member);
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_forget_failed" },
        "connection-registry forget failed (fail-open)",
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

  return {
    register,
    unregister,
    refreshSocket,
    claimSeatFrom,
    forgetSeat,
    count,
  };
}
