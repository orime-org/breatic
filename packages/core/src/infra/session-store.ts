// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Redis-backed session store for authentication tokens.
 *
 * Key format: `{env}:session:{token}` → user_id (UUID string).
 * Default TTL: 30 days.
 */

import type Redis from "ioredis";
import { env } from "@core/config/env.js";

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

/**
 * Delete a single session token.
 * @param redis - connected ioredis instance (session DB)
 * @param token - the session token to delete
 */
export async function deleteSession(redis: Redis, token: string): Promise<void> {
  await redis.del(sessionKey(token));
}

/**
 * Delete all sessions for a user (logout everywhere).
 * @param redis - connected ioredis instance (session DB)
 * @param userId - the user whose sessions are all revoked
 */
export async function deleteAllSessions(redis: Redis, userId: string): Promise<void> {
  const pattern = `${env.ENV}:session:*`;
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      for (const key of keys) { pipeline.get(key); }
      const values = await pipeline.exec();
      const toDelete: string[] = [];
      if (values) {
        for (let i = 0; i < keys.length; i++) {
          const [err, val] = values[i] ?? [];
          if (!err && val === userId) toDelete.push(keys[i]!);
        }
      }
      if (toDelete.length > 0) await redis.del(...toDelete);
    }
  } while (cursor !== "0");
}
