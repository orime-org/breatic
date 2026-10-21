// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Redis-backed session store for authentication tokens.
 *
 * Key format: `{env}:session:{token}` → user_id (UUID string).
 * Default TTL: 30 days.
 */

import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { env } from "@core/config/env.js";
import { publishSessionsRevoked } from "@core/infra/control-events.js";

/**
 * Name of the httpOnly session cookie, namespaced per deployment.
 *
 * Single source of truth shared by every backend service: the server writes /
 * reads / clears it through `setSessionCookie` &c., and collab parses it off
 * the WebSocket upgrade request in `onAuthenticate`. Defined here (next to the
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

/**
 * Build the Redis key for a session token.
 * @param token - the opaque session token
 * @returns the environment-scoped Redis key `{env}:session:{token}`
 */
function sessionKey(token: string): string {
  return `${env.ENV}:session:${token}`;
}

/**
 * Store a session token → user_id mapping with TTL.
 * @param redis - connected ioredis instance (session DB)
 * @param token - the session token to store
 * @param userId - the user the token authenticates
 */
export async function setSession(redis: Redis, token: string, userId: string): Promise<void> {
  await redis.set(sessionKey(token), userId, "EX", SESSION_TTL_SECONDS);
}

/**
 * Resolve a session token to a user ID. Returns null if expired/invalid.
 * @param redis - connected ioredis instance (session DB)
 * @param token - the session token to resolve
 * @returns the user ID, or `null` if the token is expired or unknown
 */
export async function getSession(redis: Redis, token: string): Promise<string | null> {
  return redis.get(sessionKey(token));
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
  try {
    await publishSessionsRevoked(userId, tokens.map(sessionId));
    return {};
  } catch (err) {
    return { signalFailure: err };
  }
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
  const results = await redis.multi().get(key).del(key).exec();
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
        await redis.del(...toDelete);
        ended.push(...toDelete.map((key) => key.slice(prefix.length)));
      }
    }
  } while (cursor !== "0");
  return announce(userId, ended);
}
