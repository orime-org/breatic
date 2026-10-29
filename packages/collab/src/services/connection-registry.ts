// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-instance seat registry for the per-document connection cap (#1421).
 *
 * Production runs multiple collab instances behind a load balancer, so
 * Hocuspocus's local `document.getConnectionsCount()` only sees THIS
 * instance's connections — a doc could hold N×cap connections cluster-wide
 * before any instance trips the cap. This registry makes the count
 * authoritative across instances by recording each writable connection in a
 * Redis sorted set on the collab-coordination DB (`REDIS_COLLAB_URL`, DB3,
 * same connection family as the Hocuspocus pub/sub + the Space count lock).
 *
 * Data model — one sorted set per document:
 *   key    = `{env}:collab:seats:{documentName}`
 *   member = `{userId}:{arrivedAtMs}:{instanceId}:{socketId}`
 *   score  = epoch ms this connection was last heard from — the moment it
 *            took the seat, then the moment of each pong after that
 *
 * `arrivedAtMs` is the moment the connection's handshake for this document
 * began. It orders one person's connections: when the document is full, an
 * arriving connection may replace only a seat of the same person that
 * arrived before it.
 *
 * EVERY NEW MEMBER GOES THROUGH ONE LUA SCRIPT ({@link SEAT_SCRIPT}), which
 * prunes, counts against the cap and, when the document is full, replaces one
 * of the same person's earlier seats — in one step, so two handshakes can
 * never both read "one seat left". It runs in two modes: `arrive` (the
 * `connected` hook taking a seat, and a pong retrying an arrival Redis could
 * not answer) and `refresh` (a pong renewing a seat it holds). Only `arrive`
 * replaces; a `refresh` whose member is gone re-takes a seat when there is
 * room and otherwise reports the seat lost.
 *
 * A score is written only by that script, and the script runs only for a
 * connection taking its seat or answering a ping. The key's TTL is renewed by
 * the same script, so a key lives exactly as long as some member in it is
 * still answering.
 *
 * Per entry, this instance keeps `{ member, userId, arrivedAtMs, cap, state,
 * inFlight }` (see `SeatEntry`) and sends
 * at most one script at a time. A reply is applied only to the entry that
 * sent it; an entry removed while its script was in flight (disconnect,
 * demote) is released with a ZREM on the same client, which Redis executes
 * after the script, so no member is left behind.
 *
 * FAIL-OPEN: every Redis call is best-effort. The cap is a soft protection
 * (over-cap connections degrade to read-only, they are not rejected), so a
 * Redis outage must NOT lock everyone out — `count` returns 0 on error,
 * `takeSeat` answers `unknown` (the connection keeps writing and retries its
 * arrival on the next pong), and the release paths swallow errors.
 *
 * Meta-doc exemption is the CALLER's policy (the auth hook decides which
 * connections get a ceiling), not this module's.
 */
import { env, type Redis } from "@breatic/core";
import { createLogger } from "@breatic/core";

const logger = createLogger("conn-registry");

/**
 * Slack above one ping period, in ms, before a seat counts as not answering.
 *
 * The ping period is the transport's, so a live seat's score is at most one
 * period old plus the interval firing late, the round trip, the ZADD, and
 * whatever two instances' clocks disagree by. This is that remainder.
 */
const SILENT_SEAT_JITTER_MS = 3_000;

/**
 * The score below which a seat counts as one that stopped answering.
 *
 * It has to land between two measured quantities. Above it is the live
 * ceiling: a seat's score is rewritten once per ping period, so immediately
 * before each refresh a perfectly healthy seat is one full period stale.
 * Below it is the reconnect floor: a seat the transport has not terminated
 * yet and whose client is coming back cannot be fresher than that client's
 * own reconnect delay, measured at 36991 ms with `@hocuspocus/provider` 4.6.0
 * (a 30 s `messageReconnectTimeout`, three 3 s checks, a 1 s backoff).
 *
 * Land on the live ceiling and a late interval reads as a dead connection.
 * Land above the reconnect floor and a reconnecting person's abandoned seat
 * reads as a live one, so the handover takes the tab they are typing in and
 * leaves the dead seat holding a slot.
 * @param t - Now, in epoch ms.
 * @param pingIntervalMs - How often the transport pings each connection.
 * @returns The cutoff score.
 */
export function silentSeatCutoff(t: number, pingIntervalMs: number): number {
  return t - (pingIntervalMs + SILENT_SEAT_JITTER_MS);
}

/** The four things a member string carries, once taken apart. */
export interface SeatMember {
  /** The authenticated user holding the seat. */
  userId: string;
  /** Epoch ms that connection began its handshake for this document. */
  arrivedAtMs: number;
  /** The instance holding it. */
  instanceId: string;
  /** The socket it arrived on. */
  socketId: string;
}

/**
 * The member string a seat is stored under.
 * @param holder - Who holds it, on which socket, and when they arrived.
 * @param instanceId - The instance holding it.
 * @returns `{userId}:{arrivedAtMs}:{instanceId}:{socketId}`.
 */
export function seatMember(holder: SeatHolder, instanceId: string): string {
  return `${seatPrefix(holder.userId)}${holder.arrivedAtMs}:${instanceId}:${holder.socketId}`;
}

/**
 * What every member of one person's seats starts with.
 * @param userId - The person.
 * @returns `{userId}:`.
 */
export function seatPrefix(userId: string): string {
  return `${userId}:`;
}

/**
 * Take a member string apart; the inverse of {@link seatMember}.
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
  const arrivedAtMs = Number(at);
  if (!Number.isFinite(arrivedAtMs)) return null;
  return { userId, arrivedAtMs, instanceId, socketId };
}

/**
 * The one place a member is added to a seat set (see module doc).
 *
 * KEYS[1] the seat key. ARGV: prune line, cap, member, score (now), key TTL
 * in seconds, mode (`arrive` | `refresh`), the person's member prefix
 * (`{userId}:`), the not-answering line ({@link silentSeatCutoff}), and this
 * connection's `arrivedAtMs`.
 *
 * Replies `{'kept' | 'seated' | 'replaced' | 'full', detail}`: `kept` when the
 * member is already there (whatever the cap — a lowered cap evicts nobody),
 * `seated` when there was room, `replaced` with the member it took (`arrive`
 * only), `full` with the live count.
 *
 * `arrive` replaces only a seat of the same person that arrived BEFORE this
 * connection (a smaller `arrivedAtMs`; on a tie, the smaller member string),
 * preferring one that stopped answering, then the earliest. So tabs arriving
 * together leave the latest ones seated, and a retry after an error never
 * takes the seat of a connection that came after it. A member whose
 * `arrivedAtMs` cannot be read is never replaced.
 */
const SEAT_SCRIPT = `
local key, cutoff, cap, member, score, ttl = KEYS[1], ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], ARGV[5]
local mode, prefix, silentBefore, mine = ARGV[6], ARGV[7], tonumber(ARGV[8]), tonumber(ARGV[9])
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
if redis.call('ZSCORE', key, member) then
  redis.call('ZADD', key, score, member)
  redis.call('EXPIRE', key, ttl)
  return {'kept', ''}
end
local live = redis.call('ZCARD', key)
if live < cap then
  redis.call('ZADD', key, score, member)
  redis.call('EXPIRE', key, ttl)
  return {'seated', ''}
end
if mode == 'arrive' then
  local best, bestSilent, bestAt
  local all = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  for i = 1, #all, 2 do
    local m = all[i]
    if string.sub(m, 1, #prefix) == prefix then
      local at = tonumber(string.match(m, '^[^:]+:(%d+):'))
      local earlier = at and (at < mine or (at == mine and m < member))
      local silent = tonumber(all[i + 1]) < silentBefore and 0 or 1
      if earlier and (best == nil or silent < bestSilent or (silent == bestSilent and (at < bestAt or (at == bestAt and m < best)))) then
        best, bestSilent, bestAt = m, silent, at
      end
    end
  end
  if best then
    redis.call('ZREM', key, best)
    redis.call('ZADD', key, score, member)
    redis.call('EXPIRE', key, ttl)
    return {'replaced', best}
  end
end
return {'full', tostring(live)}
`;

/** Who takes a seat, and when their connection arrived on the document. */
export interface SeatHolder {
  /** Hocuspocus socket id (unique within this instance). */
  socketId: string;
  /** The authenticated user this connection belongs to. */
  userId: string;
  /** Epoch ms the handshake for this document began (`AuthContext.arrivedAtMs`). */
  arrivedAtMs: number;
}

/** What {@link ConnectionRegistry.takeSeat} found. */
export type TakeSeatResult =
  /** There was room (or the seat was already this connection's). */
  | { outcome: "seated" }
  /** The document was full; one of this person's earlier seats was taken. */
  | { outcome: "replaced"; replaced: string }
  /** The document was full and nothing could be taken. */
  | { outcome: "full"; liveCount: number }
  /** Redis could not answer; the next pong retries the arrival. */
  | { outcome: "unknown" }
  /** The connection was released or demoted before the answer came back. */
  | { outcome: "gone" };

/** Something a pong's renewal found that its caller has to act on. */
export type SeatRefreshResult =
  /** A retried arrival took one of this person's earlier seats. */
  | { documentName: string; member: string; outcome: "replaced"; replaced: string }
  /** A retried arrival found `liveCount` seats taken under its `cap`. */
  | { documentName: string; member: string; outcome: "full"; liveCount: number; cap: number }
  /** A held seat was gone and `liveCount` seats taken under its `cap`. */
  | { documentName: string; member: string; outcome: "lost"; liveCount: number; cap: number };

/** Whether a person holds a seat; `unknown` when Redis could not answer. */
export type OwnSeat = "yes" | "no" | "unknown";

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
   * Take a seat on `documentName` for a writable connection, atomically
   * against the cap. The entry is recorded before the script is sent, so a
   * disconnect or demote during the round trip releases it.
   * @param documentName - Hocuspocus document the socket attached to.
   * @param holder - Who is connecting, and when they arrived.
   * @param cap - The ceiling the handshake judged this connection by.
   * @returns What the script found (see {@link TakeSeatResult}).
   */
  takeSeat(documentName: string, holder: SeatHolder, cap: number): Promise<TakeSeatResult>;
  /**
   * Release a cleanly-disconnected connection's seat.
   * @param documentName - Document the socket was attached to.
   * @param socketId - Socket id whose seat to release.
   * @returns once the ZREM has been attempted (best-effort / fail-open).
   */
  unregister(documentName: string, socketId: string): Promise<void>;
  /**
   * Run the seat script for every entry of this socket that has none in
   * flight, because it just answered a ping: `arrive` for an arrival Redis
   * could not answer, `refresh` for a held seat.
   * @param socketId - The socket that answered.
   * @returns What the caller has to act on; empty when nothing changed.
   */
  refreshSocket(socketId: string): Promise<SeatRefreshResult[]>;
  /**
   * Whether `userId` holds an unexpired seat on `documentName`.
   * @param documentName - Document that is at capacity.
   * @param userId - The person arriving.
   * @returns `yes`, `no`, or `unknown` when Redis could not answer.
   */
  hasOwnSeat(documentName: string, userId: string): Promise<OwnSeat>;
  /**
   * Let go of a seat whose connection was demoted to read-only. Removes the
   * member from Redis as well as from this instance's bookkeeping.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was replaced.
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

/** The two modes of {@link SEAT_SCRIPT}. */
type ScriptMode = "arrive" | "refresh";

/**
 * This instance's record of one seat: its member, who holds it and when they
 * arrived, the ceiling it was judged by, and where its script stands.
 */
interface SeatEntry {
  /** The member string in Redis. */
  member: string;
  /** Who holds it, for the script's own-seat prefix. */
  userId: string;
  /** When the connection arrived, for the script's ordering. */
  arrivedAtMs: number;
  /** The ceiling the handshake judged this connection by. */
  cap: number;
  /** `arriving` until a script gave a definite answer, then `held`. */
  state: "arriving" | "held";
  /** Whether a script for this entry is in flight. */
  inFlight: boolean;
}

/** A script reply once applied to its entry. */
type Applied =
  | { kind: "gone" }
  | { kind: "error" }
  | { kind: "seated" }
  | { kind: "replaced"; replaced: string }
  | { kind: "full"; liveCount: number };

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
  const ttlSeconds = Math.ceil((seatExpiryMs * 2) / 1000);

  // socketId -> documentName -> the entry this instance holds. The member is
  // stored rather than rebuilt because `onDisconnect` gets a socket id and
  // nothing else.
  const bySocket = new Map<string, Map<string, SeatEntry>>();

  /**
   * Whether `entry` is still the one this instance holds for that socket and
   * document — the check every reply passes before it may change anything.
   * @param socketId - The socket.
   * @param documentName - The document.
   * @param entry - The entry that sent the script.
   * @returns True when it has not been removed or replaced.
   */
  function isCurrent(socketId: string, documentName: string, entry: SeatEntry): boolean {
    return bySocket.get(socketId)?.get(documentName) === entry;
  }

  /**
   * Drop the entry for that socket and document from this instance's map.
   * @param socketId - The socket.
   * @param documentName - The document.
   * @returns The entry that was there, if any.
   */
  function drop(socketId: string, documentName: string): SeatEntry | undefined {
    const seats = bySocket.get(socketId);
    const entry = seats?.get(documentName);
    if (seats) {
      seats.delete(documentName);
      if (seats.size === 0) bySocket.delete(socketId);
    }
    return entry;
  }

  /**
   * ZREM one member. Sent on the same client as every script, so Redis runs
   * it after any script already sent for that member.
   * @param documentName - Document whose set to remove from.
   * @param member - The member.
   * @param tag - Log tag for a failure.
   * @returns once attempted (fail-open).
   */
  async function release(documentName: string, member: string, tag: string): Promise<void> {
    try {
      await redis.zrem(keyFor(documentName), member);
    } catch (err) {
      logger.warn({ err, documentName, tag }, "connection-registry release failed (fail-open)");
    }
  }

  /**
   * Send {@link SEAT_SCRIPT} for one entry. Synchronous up to the send, so a
   * removal issued after this call is ordered after the script in Redis.
   * @param documentName - The document.
   * @param entry - The entry.
   * @param mode - Which mode to run.
   * @returns The raw reply.
   */
  function sendScript(documentName: string, entry: SeatEntry, mode: ScriptMode): Promise<unknown> {
    const t = now();
    return redis.eval(
      SEAT_SCRIPT,
      1,
      keyFor(documentName),
      t - seatExpiryMs,
      entry.cap,
      entry.member,
      t,
      ttlSeconds,
      mode,
      seatPrefix(entry.userId),
      silentSeatCutoff(t, pingIntervalMs),
      entry.arrivedAtMs,
    );
  }

  /**
   * Run the script for an entry and apply its reply.
   *
   * A reply whose entry has been removed or replaced is dropped without a
   * trace: whoever removed it already sent the ZREM. `full` removes the entry
   * and releases its member. A Redis error leaves the entry's state as it
   * was, so an arrival is retried as an arrival on the next pong.
   * @param socketId - The socket.
   * @param documentName - The document.
   * @param entry - The entry, already marked in flight.
   * @param mode - Which mode to run.
   * @returns What came of it.
   */
  async function run(
    socketId: string,
    documentName: string,
    entry: SeatEntry,
    mode: ScriptMode,
  ): Promise<Applied> {
    let reply: unknown;
    try {
      reply = await sendScript(documentName, entry, mode);
    } catch (err) {
      if (!isCurrent(socketId, documentName, entry)) return { kind: "gone" };
      entry.inFlight = false;
      const tag = mode === "arrive" ? "conn_registry_take_failed" : "conn_registry_refresh_failed";
      logger.warn({ err, documentName, tag }, "connection-registry seat script failed (fail-open)");
      return { kind: "error" };
    }
    if (!isCurrent(socketId, documentName, entry)) return { kind: "gone" };
    entry.inFlight = false;
    const [status, detail] = reply as [string, string];
    if (status === "full") {
      drop(socketId, documentName);
      await release(documentName, entry.member, "conn_registry_release_failed");
      return { kind: "full", liveCount: Number(detail) };
    }
    entry.state = "held";
    if (status === "replaced") return { kind: "replaced", replaced: detail };
    return { kind: "seated" };
  }

  /**
   * Take a seat (see {@link ConnectionRegistry.takeSeat}).
   * @param documentName - The document.
   * @param holder - Who, and when they arrived.
   * @param cap - The ceiling.
   * @returns What the script found.
   */
  async function takeSeat(
    documentName: string,
    holder: SeatHolder,
    cap: number,
  ): Promise<TakeSeatResult> {
    const entry: SeatEntry = {
      member: seatMember(holder, instanceId),
      userId: holder.userId,
      arrivedAtMs: holder.arrivedAtMs,
      cap,
      state: "arriving",
      inFlight: true,
    };
    let seats = bySocket.get(holder.socketId);
    if (!seats) {
      seats = new Map();
      bySocket.set(holder.socketId, seats);
    }
    seats.set(documentName, entry);
    const applied = await run(holder.socketId, documentName, entry, "arrive");
    switch (applied.kind) {
      case "gone":
        return { outcome: "gone" };
      case "error":
        return { outcome: "unknown" };
      case "seated":
        return { outcome: "seated" };
      case "replaced":
        return { outcome: "replaced", replaced: applied.replaced };
      case "full":
        return { outcome: "full", liveCount: applied.liveCount };
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
    const entry = drop(socketId, documentName);
    if (entry === undefined) return;
    await release(documentName, entry.member, "conn_registry_unregister_failed");
  }

  /**
   * Renew, or retry, every seat this socket holds (see
   * {@link ConnectionRegistry.refreshSocket}).
   * @param socketId - The socket that answered.
   * @returns What the caller has to act on.
   */
  async function refreshSocket(socketId: string): Promise<SeatRefreshResult[]> {
    const seats = bySocket.get(socketId);
    if (!seats) return [];
    const pending: Promise<SeatRefreshResult | null>[] = [];
    for (const [documentName, entry] of seats) {
      if (entry.inFlight) continue;
      entry.inFlight = true;
      const mode: ScriptMode = entry.state === "arriving" ? "arrive" : "refresh";
      const { member, cap } = entry;
      pending.push(
        run(socketId, documentName, entry, mode).then((applied): SeatRefreshResult | null => {
          if (applied.kind === "replaced") {
            return { documentName, member, outcome: "replaced", replaced: applied.replaced };
          }
          if (applied.kind !== "full") return null;
          const outcome = mode === "arrive" ? "full" : "lost";
          return { documentName, member, outcome, liveCount: applied.liveCount, cap };
        }),
      );
    }
    const results = await Promise.all(pending);
    return results.filter((r): r is SeatRefreshResult => r !== null);
  }

  /**
   * Whether this person holds an unexpired seat here.
   * @param documentName - The document.
   * @param userId - The person.
   * @returns `yes`, `no`, or `unknown` on a Redis error.
   */
  async function hasOwnSeat(documentName: string, userId: string): Promise<OwnSeat> {
    try {
      const live = await redis.zrangebyscore(
        keyFor(documentName),
        `(${now() - seatExpiryMs}`,
        "+inf",
      );
      return live.some((member) => member.startsWith(seatPrefix(userId))) ? "yes" : "no";
    } catch (err) {
      logger.warn(
        { err, documentName, tag: "conn_registry_own_seat_failed" },
        "connection-registry own-seat query failed (fail-open → unknown)",
      );
      return "unknown";
    }
  }

  /**
   * Let go of a seat whose connection was demoted.
   *
   * Both halves are needed: the member comes out of this instance's map so no
   * pong touches it again, and out of Redis — the replacing script already
   * removed it, but a script of this entry still in flight could have
   * written it back, and this ZREM runs after it. Removing a member that is
   * already gone is a no-op.
   * @param documentName - Document the seat was on.
   * @param member - The member string that was replaced.
   * @returns once attempted (fail-open).
   */
  async function forgetSeat(
    documentName: string,
    member: string,
  ): Promise<void> {
    for (const [socketId, seats] of bySocket) {
      if (seats.get(documentName)?.member !== member) continue;
      drop(socketId, documentName);
      break;
    }
    await release(documentName, member, "conn_registry_forget_failed");
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
    takeSeat,
    unregister,
    refreshSocket,
    hasOwnSeat,
    forgetSeat,
    count,
  };
}
