// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Distributed lock that serializes every Space RPC that changes a project's
 * Space count — `space:create`, `space:restore`, `space:delete` — per
 * project ACROSS collab instances.
 *
 * Production runs multiple collab instances synced via Redis pub/sub.
 * Both count guards — "a project keeps at least one Space" and "a project
 * holds at most `MAX_SPACES_PER_PROJECT`" — read a count and then write, a
 * classic read-modify-write. Two collaborators on DIFFERENT instances each
 * see their own not-yet-synced meta doc, so without this lock both could pass
 * a guard and the project could race to zero Spaces or past the cap. The lock
 * makes each critical section (authoritative PG count + meta mutation + PG
 * content-row write) mutually exclusive per project across every instance.
 *
 * It lives on the collab-coordination Redis (`REDIS_COLLAB_URL`, DB3) —
 * the same connection family as the Hocuspocus cross-instance pub/sub —
 * not on the app-tier lock DB (DB0) or the cross-service Streams (DB2).
 *
 * FENCING: each acquire writes a UNIQUE token (`SET key <token> EX ttl
 * NX`) and releases via a check-and-del Lua script, so an instance whose
 * lock expired and was re-acquired elsewhere never DELs the new holder's
 * lock. (Unlike `creditLot.service.chargeOnceForGeneration`, which uses a
 * fixed value —
 * that is an idempotency key, not a mutex, so a wrong DEL there is
 * harmless; here it would let a third delete interleave.)
 *
 * RESIDUAL (inherent to any TTL lock): if the critical section itself
 * runs longer than the TTL, the lock expires WHILE still in use and a
 * second instance can enter — fencing prevents the wrong-key DEL but not
 * this concurrency. Mitigated by a TTL far larger than the real critical
 * section (a PG count + a meta transact + a PG row write, normally well
 * under a second); a stall past the TTL means the whole system is already
 * severely degraded. This is the standard TTL-lock tradeoff.
 */
import { randomUUID } from "node:crypto";
import { createLogger, getCollabRedis, env } from "@breatic/core";

const logger = createLogger("space-count-lock");

/**
 * Lock time-to-live (seconds) — crash safety net so a holder that dies
 * mid-section can't deadlock the project's later Space changes. Set FAR
 * larger than the real critical section (one PG count + a meta-doc transact +
 * one PG row write, normally well under a second) so the lock does not
 * expire mid-use under normal / moderately-slow conditions; still short
 * enough that a crashed holder self-heals within seconds.
 */
const LOCK_TTL_SECONDS = 30;

/**
 * Check-and-del release: DEL the lock ONLY if it still holds our token,
 * so an expired-then-reacquired lock is never deleted by its old holder.
 */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/**
 * Default acquire attempts before giving up. With the 100 ms delay this waits
 * about five seconds, so creates, restores and deletes that collaborators fire
 * at the same moment queue up behind each other instead of being refused.
 */
const DEFAULT_RETRY_ATTEMPTS = 50;
/** Default delay between acquire attempts (ms). */
const DEFAULT_RETRY_DELAY_MS = 100;

/**
 * Thrown when the per-project Space count lock could not be acquired within
 * the retry budget — other Space changes held it the whole time. The caller
 * maps this to `BUSY` so the reader is told to try again.
 */
export class SpaceCountLockBusyError extends Error {
  /**
   * Build the busy error for a project whose Space count lock is held.
   * @param projectId - Project whose lock was contended.
   */
  constructor(projectId: string) {
    super(`space count lock busy for project ${projectId}`);
    this.name = "SpaceCountLockBusyError";
  }
}

/**
 * Build the per-project Space count lock key. The key keeps its original
 * `space-delete` segment so instances on either side of a deploy share it.
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
 * Run `fn` while holding a per-project distributed lock so the Space RPCs that
 * change the Space count are serialized across collab instances.
 *
 * Acquires `SET key <token> EX <ttl> NX` on the collab-coordination Redis
 * (DB3); retries a bounded number of times then gives up. Releases the lock in a `finally` so `fn` throwing never
 * leaks it; the TTL is a crash safety net. The lock is released ONLY if
 * it was acquired — a failed acquire never DELs a key it does not own.
 * @param projectId - Project whose Space count changes are serialized.
 * @param fn - The critical section (count + write) to run under the lock.
 * @param opts - Optional retry/TTL overrides (mainly for tests).
 * @param opts.ttlSeconds - Lock TTL in seconds.
 * @param opts.retryAttempts - Acquire attempts before giving up.
 * @param opts.retryDelayMs - Delay between acquire attempts.
 * @returns Whatever `fn` resolves to.
 * @throws {SpaceCountLockBusyError} When the lock cannot be acquired within the retry budget.
 */
export async function withSpaceCountLock<T>(
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
    throw new SpaceCountLockBusyError(projectId);
  }

  try {
    return await fn();
  } finally {
    // Fenced release: only DEL if we still own the lock (see RELEASE_SCRIPT).
    //
    // Swallowed on purpose. A throw inside `finally` REPLACES whatever the
    // critical section returned, so an unreachable Redis would turn a change
    // that already broadcast into an internal error carrying Redis's own
    // words. The lock's TTL means a release that never happened costs a
    // short wait, not correctness — which is the cheaper of the two.
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (releaseError) {
      logger.warn(
        { err: releaseError, projectId, key },
        "space_count_lock_release_failed",
      );
    }
  }
}
