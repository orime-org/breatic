/**
 * Redis-backed canvas node locks.
 *
 * Prevents two users (or even the same user racing) from kicking
 * off concurrent operations on the same canvas node. Acquired at
 * the start of `/canvas/tasks` or `/assets/upload/prepare`, released
 * by the Collab event handler when the node transitions back to
 * `idle` (either via completed or failed event).
 *
 * The lock payload stores the handling actor so the same user can
 * re-enter (idempotent) while other users get rejected. A 2-hour
 * TTL bounds the worst case — long enough for 1 GB video uploads
 * or 10-minute 3D generation, short enough to eventually recover
 * from a crashed Worker that never released its lock.
 */

import type Redis from "ioredis";
import type { HandlingActor } from "@breatic/shared";
import { env } from "../config/env.js";

/** Lock TTL in seconds (2 hours). */
const LOCK_TTL_SECONDS = 2 * 60 * 60;

/** Shape persisted as the lock value. */
interface LockEntry {
  userId: string;
  username: string;
  taskId: string;
  lockedAt: number;
}

/** Build the Redis key for a canvas node lock. */
export function nodeLockKey(projectId: string, nodeId: string): string {
  return `${env.ENV}:canvas:lock:${projectId}:${nodeId}`;
}

/**
 * Attempt to acquire the lock for a canvas node.
 *
 * Idempotent for the same user: if the caller already holds the
 * lock, returns `true` without modifying the entry.
 *
 * @returns `true` if the caller holds the lock after this call,
 *          `false` if a different user already holds it.
 */
export async function acquireNodeLock(
  redis: Redis,
  projectId: string,
  nodeId: string,
  actor: HandlingActor,
  taskId: string,
): Promise<boolean> {
  const key = nodeLockKey(projectId, nodeId);
  const entry: LockEntry = {
    userId: actor.userId,
    username: actor.username,
    taskId,
    lockedAt: Date.now(),
  };

  // SET NX — set only if key does not exist
  const result = await redis.set(
    key,
    JSON.stringify(entry),
    "EX",
    LOCK_TTL_SECONDS,
    "NX",
  );
  if (result === "OK") return true;

  // Key exists — check if it's the same user (idempotent re-acquire)
  const existingRaw = await redis.get(key);
  if (!existingRaw) {
    // Race: expired between SETNX and GET. Try once more.
    const retry = await redis.set(
      key,
      JSON.stringify(entry),
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );
    return retry === "OK";
  }

  try {
    const existing = JSON.parse(existingRaw) as LockEntry;
    return existing.userId === actor.userId;
  } catch {
    // Corrupt value — reset it
    await redis.set(key, JSON.stringify(entry), "EX", LOCK_TTL_SECONDS);
    return true;
  }
}

/**
 * Release a canvas node lock, verifying the caller holds it.
 *
 * Uses a Redis Lua script (CAS): only deletes if the stored taskId
 * matches. This prevents a forged/stale event from releasing another
 * task's lock.
 *
 * @returns true if released or already gone, false if held by different task
 */
// Lua script for atomic check-and-delete (runs on Redis server, not JS eval)
const RELEASE_LOCK_LUA = `
  local v = redis.call('GET', KEYS[1])
  if not v then return 0 end
  local ok, data = pcall(cjson.decode, v)
  if not ok then redis.call('DEL', KEYS[1]) return 1 end
  if data.taskId == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return -1
`;

export async function releaseNodeLock(
  redis: Redis,
  projectId: string,
  nodeId: string,
  taskId: string,
): Promise<boolean> {
  const key = nodeLockKey(projectId, nodeId);
  // redis.eval runs a Lua script on the Redis server (not JS eval)
  const result = await redis.eval(RELEASE_LOCK_LUA, 1, key, taskId) as number;
  return result >= 0; // 0 = already gone, 1 = released, -1 = wrong holder
}

/**
 * Read the current lock holder without modifying the lock.
 *
 * Useful for debugging and for guarding operations like node
 * deletion ("can't delete a handling node").
 */
export async function readNodeLock(
  redis: Redis,
  projectId: string,
  nodeId: string,
): Promise<LockEntry | null> {
  const raw = await redis.get(nodeLockKey(projectId, nodeId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockEntry;
  } catch {
    return null;
  }
}
