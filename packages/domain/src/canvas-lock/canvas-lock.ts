// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Canvas node-level Redis lock for `mode='overwrite'` tasks (spec §10.15.2).
 *
 * Why exists:
 *   Yjs LWW would silently merge two concurrent overwrite results, losing
 *   one user's generation (and the credits spent). CRDT can't reason about
 *   "two complete generation results — pick one"; we must add a lock above
 *   the protocol layer.
 *
 * Mechanism:
 *   - SETNX with TTL — first writer wins (spec §10.15.2)
 *   - Value = taskId so the worker can verify ownership before writing the
 *     result + before releasing (defense against TTL-expired-then-reclaimed)
 *
 * Storage: DB 0 (general purpose; same as session / rate-limit).
 */
import type { Redis } from "@breatic/core";
import { env } from "@breatic/core";
import { getRedis } from "@breatic/core";

/**
 * TTL for the lock in seconds. 7200s (2h) is comfortably longer than any
 * generation task we run; if a worker truly stalls past this point we treat
 * it as crashed and let a new actor reclaim the node (spec §10.15.6).
 */
export const CANVAS_LOCK_TTL_SECONDS = 7200;

/**
 * Build the Redis key for a canvas-node lock. Scoped by `env.ENV` so
 * dev / staging / prod don't collide on the same Redis instance —
 * matching every other namespaced Redis key (session / ratelimit /
 * stream / bill). Previously read the non-existent `env.NODE_ENV`,
 * which t3-env stripped to `undefined` at runtime, emitting
 * `undefined:canvas:lock:…` keys; the env-injection refactor's
 * stricter typing surfaced and fixed that (2026-05-30).
 * @param projectId - UUID of the project owning the node
 * @param nodeId - UUID of the canvas node being locked
 * @returns The namespaced Redis key `{env}:canvas:lock:{projectId}:{nodeId}`.
 */
export function canvasNodeLockKey(projectId: string, nodeId: string): string {
  return `${env.ENV}:canvas:lock:${projectId}:${nodeId}`;
}

/**
 * Try to acquire an exclusive lock on a canvas node for an overwrite task.
 * @param projectId - UUID of the project
 * @param nodeId - UUID of the target canvas node
 * @param taskId - The acquiring task's UUID (becomes the lock value)
 * @param redis - Optional Redis client (defaults to general-purpose DB 0)
 * @returns true if the lock was acquired, false if another task holds it
 */
export async function acquireCanvasNodeLock(
  projectId: string,
  nodeId: string,
  taskId: string,
  redis: Redis = getRedis(),
): Promise<boolean> {
  const key = canvasNodeLockKey(projectId, nodeId);
  const result = await redis.set(
    key,
    taskId,
    "EX",
    CANVAS_LOCK_TTL_SECONDS,
    "NX",
  );
  return result === "OK";
}

/**
 * Take the lock back for a retry attempt of the SAME task (#1580
 * adversarial fix: retry lock continuity). `runTask` releases the lock in
 * its `finally` on every attempt — including a rethrow that schedules a
 * BullMQ retry — so a retry must re-acquire before touching the node.
 * Succeeds when the lock is free (normal case: attempt N-1 released it) OR
 * already held by this task (release failed / never ran); fails when
 * another task legitimately took the node between attempts — the caller
 * must then abort WITHOUT billing (its write-backs would be gen-fenced
 * anyway).
 * @param projectId - UUID of the project
 * @param nodeId - UUID of the target canvas node
 * @param taskId - The retrying task's UUID (the lock value)
 * @param redis - Optional Redis client (defaults to general-purpose DB 0)
 * @returns true if this task holds the lock after the call
 */
export async function reacquireCanvasNodeLock(
  projectId: string,
  nodeId: string,
  taskId: string,
  redis: Redis = getRedis(),
): Promise<boolean> {
  if (await acquireCanvasNodeLock(projectId, nodeId, taskId, redis)) {
    return true;
  }
  const holder = await redis.get(canvasNodeLockKey(projectId, nodeId));
  return holder === taskId;
}

/**
 * Read who currently holds the lock for a canvas node. Used by the conflict
 * 409 handler to look up holder details (taskId / userId / startedAt) for
 * the toast.
 * @param projectId - UUID of the project
 * @param nodeId - UUID of the target canvas node
 * @param redis - Optional Redis client (defaults to general-purpose DB 0)
 * @returns The holding task's UUID, or null if no lock is held
 */
export async function readCanvasNodeLockHolder(
  projectId: string,
  nodeId: string,
  redis: Redis = getRedis(),
): Promise<string | null> {
  return redis.get(canvasNodeLockKey(projectId, nodeId));
}

/**
 * Release the lock — only deletes if the caller still owns it. Safe to call
 * unconditionally in a `finally` block; if the TTL already expired or someone
 * else owns the key, this is a no-op.
 * @param projectId - UUID of the project
 * @param nodeId - UUID of the target canvas node
 * @param taskId - The worker's own task UUID (must match the stored value)
 * @param redis - Optional Redis client (defaults to general-purpose DB 0)
 * @returns true if the key was actually deleted
 */
export async function releaseCanvasNodeLock(
  projectId: string,
  nodeId: string,
  taskId: string,
  redis: Redis = getRedis(),
): Promise<boolean> {
  const key = canvasNodeLockKey(projectId, nodeId);
  // Compare-and-delete via Lua: only DEL when value matches taskId.
  // Avoids a race where TTL expires + someone else acquires between the
  // GET and the DEL on the JS side.
  const script = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;
  const deleted = (await redis.eval(script, 1, key, taskId)) as number;
  return deleted === 1;
}
