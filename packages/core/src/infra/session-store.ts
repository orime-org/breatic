/**
 * Redis-backed session store for authentication tokens.
 *
 * Key format: `{env}:session:{token}` → user_id (UUID string).
 * Default TTL: 30 days.
 */

import type Redis from "ioredis";
import { env } from "@core/config/env.js";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function sessionKey(token: string): string {
  return `${env.ENV}:session:${token}`;
}

/** Store a session token → user_id mapping with TTL. */
export async function setSession(redis: Redis, token: string, userId: string): Promise<void> {
  await redis.set(sessionKey(token), userId, "EX", SESSION_TTL_SECONDS);
}

/** Resolve a session token to a user ID. Returns null if expired/invalid. */
export async function getSession(redis: Redis, token: string): Promise<string | null> {
  return redis.get(sessionKey(token));
}

/** Delete a single session token. */
export async function deleteSession(redis: Redis, token: string): Promise<void> {
  await redis.del(sessionKey(token));
}

/** Delete all sessions for a user (logout everywhere). */
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
