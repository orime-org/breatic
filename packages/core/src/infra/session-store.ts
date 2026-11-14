// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Redis-backed session store for authentication tokens.
 *
 * Key format: `{env}:session:{token}` → user_id (UUID string).
 * Default TTL: 30 days.
 *
 * Beside every session sits its id index `{env}:session-id:{sid}` → user_id,
 * with the same lifetime (inner#1955): other regions know a session only by
 * its id (the SHA-256 of the token), and the global region answers which ids
 * have ended from this index. A region that hears of a revocation writes
 * `{env}:identity-revoked:{sid}` for longer than an identity token lives.
 */

import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { env } from "@core/config/env.js";
import { publishSessionsRevoked } from "@core/infra/control-events.js";
import { createQueue, defaultJobOpts } from "@core/infra/queue.js";
import { redactSessionError } from "@core/infra/session-error.js";

/**
 * Name of the httpOnly session cookie, namespaced per deployment.
 *
 * Single source of truth shared by every backend service: the server writes /
 * reads / clears it through `setSessionCookie` &c., and collab parses it during
 * native WebSocket admission and each document's `onAuthenticate`. Defined here (next to the
 * session token store) so the two can never drift.
 *
 * The `REDIS_KEY_PREFIX` suffix is what keeps concurrent deployments from
 * evicting each other's logins (#1831). Cookies are NOT scoped by port
 * (RFC 6265 §8.5): every service on `localhost` shares one cookie jar, so two
 * worktrees using the same cookie name overwrite each other's token on every
 * login — and since each looks its token up in its own Redis DB, the other
 * side reads as logged out. Ports isolate the servers; only the name isolates
 * the cookie.
 *
 * A function rather than a constant because the value is env-derived: the
 * first call must happen after the entry's `initCore()`, which holds for every
 * caller (they all run inside a request / upgrade handler).
 * @returns The cookie name for this deployment, e.g. `breatic_session_dev`.
 */
export function sessionCookieName(): string {
  return `breatic_session_${env.REDIS_KEY_PREFIX}`;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** How long a region remembers a revoked session id: longer than any identity token lives. */
const REVOKED_IDENTITY_TTL_SECONDS = 120;

/**
 * Build the Redis key for a session token.
 * @param token - the opaque session token
 * @returns the environment-scoped Redis key `{env}:session:{token}`
 */
function sessionKey(token: string): string {
  return `${env.ENV}:session:${token}`;
}

/**
 * Build the Redis key of a session's id index.
 * @param sid - the session id ({@link sessionId})
 * @returns the key `{env}:session-id:{sid}`
 */
function sessionIdKey(sid: string): string {
  return `${env.ENV}:session-id:${sid}`;
}

/**
 * Build the Redis key of a revocation tombstone.
 * @param sid - the session id
 * @returns the key `{env}:identity-revoked:{sid}`
 */
function revokedIdentityKey(sid: string): string {
  return `${env.ENV}:identity-revoked:${sid}`;
}

/**
 * Store a session token → user_id mapping with TTL.
 * @param redis - connected ioredis instance (session DB)
 * @param token - the session token to store
 * @param userId - the user the token authenticates
 */
export async function setSession(redis: Redis, token: string, userId: string): Promise<void> {
  const results = await redis
    .multi()
    .set(sessionKey(token), userId, "EX", SESSION_TTL_SECONDS)
    .set(sessionIdKey(sessionId(token)), userId, "EX", SESSION_TTL_SECONDS)
    .exec();
  const failed = results?.find(([err]) => err)?.[0];
  if (failed) throw failed;
}

/**
 * Resolve a session token to a user ID. Returns null if expired/invalid.
 * @param redis - connected ioredis instance (session DB)
 * @param token - the session token to resolve
 * @returns the user ID, or `null` if the token is expired or unknown
 * @throws {Error} When Redis cannot read the session, with credential-redacted diagnostics.
 */
export async function getSession(redis: Redis, token: string): Promise<string | null> {
  try {
    return await redis.get(sessionKey(token));
  } catch (error) {
    throw redactSessionError(error, [token]);
  }
}

/** What ending sessions did besides deleting them. */
export interface RevokeOutcome {
  /**
   * Why the announcement to collab failed, when it did. The sessions are
   * deleted either way, so REST refuses them at once; collab finds the
   * connections on its next recheck. The caller logs it.
   */
  signalFailure?: unknown;
}

/**
 * The id a session goes by outside this store: the SHA-256 of its token, so
 * what travels between processes cannot be used to sign in.
 * @param token - The session token.
 * @returns Its lowercase hex digest.
 */
export function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Announce ended sessions, reporting a failure instead of throwing: the
 * deletion it follows has already happened and must not be undone by it.
 * @param userId - Whose sessions they were.
 * @param tokens - The ended sessions' tokens.
 * @returns The outcome to hand back to the caller.
 */
async function announce(userId: string, tokens: string[]): Promise<RevokeOutcome> {
  if (tokens.length === 0) return {};
  const sids = tokens.map(sessionId);
  // Two independent signals: one failing must not hold back the other.
  const [published, forwarded] = await Promise.allSettled([
    publishSessionsRevoked(userId, sids),
    forwardToRegions(userId, sids),
  ]);
  const failed = [published, forwarded].find((outcome) => outcome.status === "rejected");
  return failed === undefined ? {} : { signalFailure: failed.reason };
}

/** The worker queue that carries revocations to the other regions (inner#1955). */
export const IDENTITY_REVOCATION_FORWARD_QUEUE = "identity-revocation-forward";

let revocationForwardQueue: ReturnType<typeof createQueue> | null = null;

/**
 * In the global region, queue the revoked session ids for every other region,
 * whose collab closes the connections they opened.
 * @param userId - Whose sessions ended.
 * @param sids - The ended session ids.
 * @returns Once queued.
 * @throws {Error} When the queue cannot be written.
 */
async function forwardToRegions(userId: string, sids: string[]): Promise<void> {
  if (env.REGION !== env.GLOBAL_REGION) return;
  const regions = Object.keys(env.REGION_API_URLS).filter((region) => region !== env.REGION);
  if (regions.length === 0) return;
  revocationForwardQueue ??= createQueue(IDENTITY_REVOCATION_FORWARD_QUEUE);
  for (const region of regions) await revocationForwardQueue.add("revoke", { region, userId, sids }, defaultJobOpts());
}

/**
 * End one session: delete it and tell collab, which closes the connections
 * opened with it. A session that is already gone announces nothing.
 * @param redis - connected ioredis instance (session DB)
 * @param token - the session token to end
 * @returns Whether announcing it failed.
 * @throws {Error} When Redis cannot delete it.
 */
export async function revokeSession(redis: Redis, token: string): Promise<RevokeOutcome> {
  const key = sessionKey(token);
  const results = await redis.multi().get(key).del(key).del(sessionIdKey(sessionId(token))).exec();
  const [err, userId] = results?.[0] ?? [];
  if (err) throw err;
  if (typeof userId !== "string") return {};
  return announce(userId, [token]);
}

/**
 * End every session of one person, except the one to keep, and tell collab.
 * @param redis - connected ioredis instance (session DB)
 * @param userId - the person whose sessions end
 * @param options - Which session survives.
 * @param options.keep - The token of the session to keep (the caller's own, for "sign out of other devices").
 * @returns Whether announcing them failed.
 * @throws {Error} When Redis cannot be scanned or written.
 */
export async function revokeAllSessions(
  redis: Redis,
  userId: string,
  options: { keep?: string } = {},
): Promise<RevokeOutcome> {
  const prefix = `${env.ENV}:session:`;
  const kept = options.keep === undefined ? null : sessionKey(options.keep);
  const ended: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      for (const key of keys) { pipeline.get(key); }
      const values = await pipeline.exec();
      const toDelete: string[] = [];
      if (values) {
        for (let i = 0; i < keys.length; i++) {
          const [err, val] = values[i] ?? [];
          if (!err && val === userId && keys[i] !== kept) toDelete.push(keys[i]!);
        }
      }
      if (toDelete.length > 0) {
        const tokens = toDelete.map((key) => key.slice(prefix.length));
        await redis.del(...toDelete, ...tokens.map((t) => sessionIdKey(sessionId(t))));
        ended.push(...tokens);
      }
    }
  } while (cursor !== "0");
  return announce(userId, ended);
}

/** Writes the id index only while the session still exists, for what is left of its lifetime. */
const BACKFILL_SCRIPT = `
local userId = redis.call("GET", KEYS[1])
if not userId then return 0 end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then return 0 end
redis.call("SET", KEYS[2], userId, "PX", ttl)
return 1
`;

/**
 * Give a session made before the id index existed its index, atomically:
 * a session revoked in the meantime gets none.
 * @param redis - connected ioredis instance (session DB)
 * @param token - the session token
 * @throws {Error} When Redis cannot run the script.
 */
export async function backfillSessionIdIndex(redis: Redis, token: string): Promise<void> {
  await redis.eval(BACKFILL_SCRIPT, 2, sessionKey(token), sessionIdKey(sessionId(token)));
}

/**
 * Which of these session ids have ended.
 * @param redis - connected ioredis instance (session DB)
 * @param sids - session ids to check
 * @returns the ids with no live session
 * @throws {Error} When Redis cannot be read.
 */
export async function checkSessions(redis: Redis, sids: readonly string[]): Promise<string[]> {
  if (sids.length === 0) return [];
  const values = await redis.mget(...sids.map(sessionIdKey));
  return sids.filter((_sid, i) => values[i] === null);
}

/**
 * Mark session ids revoked in this region for longer than an identity token lives.
 * @param redis - connected ioredis instance (session DB)
 * @param sids - the revoked session ids
 * @throws {Error} When Redis cannot be written.
 */
export async function recordRevokedIdentities(redis: Redis, sids: readonly string[]): Promise<void> {
  if (sids.length === 0) return;
  const pipeline = redis.pipeline();
  for (const sid of sids) pipeline.set(revokedIdentityKey(sid), "1", "EX", REVOKED_IDENTITY_TTL_SECONDS);
  const results = await pipeline.exec();
  const failed = results?.find(([err]) => err)?.[0];
  if (failed) throw failed;
}

/**
 * Whether a session id was revoked in this region within the last two minutes.
 * @param redis - connected ioredis instance (session DB)
 * @param sid - the session id
 * @returns true when a tombstone exists
 * @throws {Error} When Redis cannot be read.
 */
export async function isIdentityRevoked(redis: Redis, sid: string): Promise<boolean> {
  return (await redis.exists(revokedIdentityKey(sid))) === 1;
}
