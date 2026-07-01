// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Distributed lock that serializes `space:delete` per project ACROSS
 * collab instances.
 *
 * Production runs multiple collab instances synced via Redis pub/sub
 * (see docs/DEPLOY.md). The "a project must keep >=1 space" guard reads
 * a count and then deletes — a classic read-modify-write. Within one
 * instance that is atomic (a single synchronous Yjs transact on a shared
 * in-memory doc), but two collaborators on DIFFERENT instances each see
 * their own not-yet-synced doc, both pass the guard, and the project can
 * race to zero spaces. This lock makes the whole delete critical section
 * (authoritative PG count + meta mutation + PG soft-delete) mutually
 * exclusive per project across every instance.
 *
 * It lives on the collab-coordination Redis (`REDIS_COLLAB_URL`, DB3) —
 * the same connection family as the Hocuspocus cross-instance pub/sub —
 * not on the app-tier lock DB (DB0) or the cross-service Streams (DB2).
 *
 * FENCING: each acquire writes a UNIQUE token (`SET key <token> EX ttl
 * NX`) and releases via a check-and-del Lua script, so an instance whose
 * lock expired and was re-acquired elsewhere never DELs the new holder's
 * lock. (Unlike `credit.service.deductOnce`, which uses a fixed value —
 * that is an idempotency key, not a mutex, so a wrong DEL there is
 * harmless; here it would let a third delete interleave.)
 *
 * RESIDUAL (inherent to any TTL lock): if the critical section itself
 * runs longer than the TTL, the lock expires WHILE still in use and a
 * second instance can enter — fencing prevents the wrong-key DEL but not
 * this concurrency. Mitigated by a TTL far larger than the real critical
 * section (a PG count + a meta transact + a PG soft-delete, normally well
 * under a second); a stall past the TTL means the whole system is already
 * severely degraded. This is the standard TTL-lock tradeoff.
 */
import { randomUUID } from "node:crypto";
import { getCollabRedis, env } from "@breatic/core";

/**
 * Lock time-to-live (seconds) — crash safety net so a holder that dies
 * mid-delete can't deadlock a project's future deletes. Set FAR larger
 * than the real critical section (one PG count + a meta-doc transact +
 * one PG soft-delete, normally well under a second) so the lock does not
 * expire mid-use under normal / moderately-slow conditions; still short
 * enough that a crashed holder self-heals within seconds (deletes are
 * rare, so a brief project-scoped delete stall is acceptable).
 */
const LOCK_TTL_SECONDS = 30;

/**
 * Check-and-del release: DEL the lock ONLY if it still holds our token,
 * so an expired-then-reacquired lock is never deleted by its old holder.
 */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/** Default acquire attempts before giving up (delete contention is rare). */
const DEFAULT_RETRY_ATTEMPTS = 5;
/** Default delay between acquire attempts (ms). */
const DEFAULT_RETRY_DELAY_MS = 100;

/**
 * Thrown when the per-project delete lock could not be acquired within
 * the retry budget — another delete is in flight. The caller maps this
 * to a CONFLICT so the client can retry.
 */
export class SpaceDeleteLockBusyError extends Error {
  /**
   * Build the busy error for a project whose delete lock is held.
   * @param projectId - Project whose delete lock was contended.
   */
  constructor(projectId: string) {
    super(`space-delete lock busy for project ${projectId}`);
    this.name = "SpaceDeleteLockBusyError";
  }
}

/**
 * Build the per-project delete lock key.
 * @param projectId - Project the lock scopes.
 * @returns Redis key `{env}:collab:lock:space-delete:{projectId}`.
 */
function lockKey(projectId: string): string {
  return `${env.ENV}:collab:lock:space-delete:${projectId}`;
}

/**
 * Sleep for `ms` milliseconds.
 * @param ms - Delay in milliseconds.
 * @returns Resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding a per-project distributed lock so `space:delete`
 * is serialized across collab instances.
 *
 * Acquires `SET key 1 EX <ttl> NX` on the collab-coordination Redis
 * (DB3); retries a bounded number of times (delete contention is rare)
 * then gives up. Releases the lock in a `finally` so `fn` throwing never
 * leaks it; the TTL is a crash safety net. The lock is released ONLY if
 * it was acquired — a failed acquire never DELs a key it does not own.
 * @param projectId - Project whose deletes are serialized.
 * @param fn - The critical section (count + delete) to run under the lock.
 * @param opts - Optional retry/TTL overrides (mainly for tests).
 * @param opts.ttlSeconds - Lock TTL in seconds.
 * @param opts.retryAttempts - Acquire attempts before giving up.
 * @param opts.retryDelayMs - Delay between acquire attempts.
 * @returns Whatever `fn` resolves to.
 * @throws {SpaceDeleteLockBusyError} When the lock cannot be acquired within the retry budget.
 */
export async function withSpaceDeleteLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  opts?: { ttlSeconds?: number; retryAttempts?: number; retryDelayMs?: number },
): Promise<T> {
  const ttl = opts?.ttlSeconds ?? LOCK_TTL_SECONDS;
  const attempts = opts?.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const redis = getCollabRedis();
  const key = lockKey(projectId);
  const token = randomUUID();

  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await redis.set(key, token, "EX", ttl, "NX");
    if (res === "OK") {
      acquired = true;
      break;
    }
    if (attempt < attempts - 1) {
      await delay(retryDelayMs);
    }
  }
  if (!acquired) {
    throw new SpaceDeleteLockBusyError(projectId);
  }

  try {
    return await fn();
  } finally {
    // Fenced release: only DEL if we still own the lock (see RELEASE_SCRIPT).
    await redis.eval(RELEASE_SCRIPT, 1, key, token);
  }
}
