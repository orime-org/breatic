// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer reference (inner#1006): the three routes that can legitimately
 * carry more than the request body limit (`/canvas/paste`,
 * `/canvas/node-history/snapshot`, `/chat/message`) also take
 * `{ "transfer": "<storageKey>" }`, naming a transfer file the caller just
 * uploaded. This checks the reference and reads the body back out of it.
 *
 * A reference reads only the caller's own finished, fresh transfer, at most
 * once; one user has one read in flight at a time, so "read, then claim"
 * cannot hand one file out twice. A reference that finds the user's read in
 * flight waits for it, up to `transfer.read_lock_wait_seconds`. A failure the file's own content causes
 * (too large, not a transfer file, not UTF-8) uses the reference up as well,
 * so the same bad file cannot make us read it again and again; a failure that
 * is not the file's (missing object, storage error) leaves it usable.
 *
 * The two Redis keys below are written nowhere else.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  env,
  getRedis,
  getStorageAdapter,
  getStorageConfig,
  ObjectMissing,
  ObjectTooLarge,
  type StorageConfig,
} from "@breatic/core";
import { uploadGrantRepo } from "@breatic/domain";
import { decodeTransferBody, TRANSFER_KEY_DIR, TransferDecodeError } from "@breatic/shared";

/** A route that takes a transfer reference, named as in `config/storage.yaml`. */
export type TransferRoute = keyof StorageConfig["transfer"]["route_max_bytes"];

/** Why a reference was refused with 400; logged, never sent. */
export type TransferRejectReason =
  | "bad_key"
  | "not_found"
  | "not_owner"
  | "not_finished"
  | "expired"
  | "already_used"
  | "bad_format"
  | "bad_encoding";

/** What reading a transfer reference came to. */
export type TransferReadResult =
  /** The body the transfer file carries. */
  | { kind: "ok"; text: string }
  /** The reference is refused; `ownerId` names the grant's owner on `not_owner`. */
  | { kind: "rejected"; reason: TransferRejectReason; ownerId?: string }
  /** The file is larger than `cap` bytes; the reference is used up. */
  | { kind: "too_large"; cap: number }
  /** This user's read in flight did not end within the wait. */
  | { kind: "busy" }
  /** Storage failed for a reason that is not the file's; the reference stays usable. */
  | { kind: "read_failed"; err: unknown };

/** Every transfer key starts with this. */
const TRANSFER_KEY_PREFIX = `${TRANSFER_KEY_DIR}/`;

/** Delete the read lock only while it still holds this request's token. */
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/**
 * The one-time claim on a transfer file.
 * @param key - The transfer's storage key.
 * @returns The Redis key.
 */
function refKey(key: string): string {
  return `${env.REDIS_KEY_PREFIX}:server:transfer-ref:${key}`;
}

/**
 * One user's read lock.
 * @param userId - The user.
 * @returns The Redis key.
 */
function readLockKey(userId: string): string {
  return `${env.REDIS_KEY_PREFIX}:server:transfer-read:${userId}`;
}

/**
 * Claim a transfer file once.
 * @param key - The transfer's storage key.
 * @param ttlSeconds - How long the claim stands.
 * @returns True when this request claimed it.
 */
async function claim(key: string, ttlSeconds: number): Promise<boolean> {
  return (await getRedis().set(refKey(key), "1", "EX", ttlSeconds, "NX")) === "OK";
}

/**
 * Refuse a reference.
 * @param reason - Why.
 * @returns The refusal.
 */
function rejected(reason: TransferRejectReason): TransferReadResult {
  return { kind: "rejected", reason };
}

/**
 * Check the reference and read the body back; the caller holds the user's read lock.
 * @param route - Which route's cap applies.
 * @param key - The referenced key.
 * @param userId - Who is asking.
 * @returns What the read came to.
 * @throws {Error} When decoding fails for a reason other than the file's content.
 */
async function readLocked(route: TransferRoute, key: string, userId: string): Promise<TransferReadResult> {
  const { transfer } = getStorageConfig();

  const grant = await uploadGrantRepo.findGrantByKey(key);
  if (grant === null || grant.assetSource !== "transfer") return rejected("not_found");
  if (grant.userId !== userId) return { kind: "rejected", reason: "not_owner", ownerId: grant.userId };
  if (grant.consumedAt === null || grant.voidedAt !== null) return rejected("not_finished");
  if (Date.now() - grant.consumedAt.getTime() > transfer.reference_ttl_seconds * 1000) {
    return rejected("expired");
  }
  if ((await getRedis().exists(refKey(key))) === 1) return rejected("already_used");

  const cap = Math.min(transfer.route_max_bytes[route], grant.declaredSize);
  const outcome = await readBody(key, cap);
  // Only a read that succeeded or failed on the file's own content uses the
  // reference up; the others leave it usable.
  const claims =
    outcome.kind === "ok" ||
    outcome.kind === "too_large" ||
    (outcome.kind === "rejected" && (outcome.reason === "bad_format" || outcome.reason === "bad_encoding"));
  if (claims && !(await claim(key, transfer.reference_ttl_seconds))) return rejected("already_used");
  return outcome;
}

/**
 * Read and decode the transfer file, without claiming it.
 * @param key - The transfer's storage key.
 * @param cap - The most bytes to read.
 * @returns The body, or why it could not be had.
 * @throws {Error} When decoding fails for a reason other than the file's content.
 */
async function readBody(key: string, cap: number): Promise<TransferReadResult> {
  let bytes: Uint8Array;
  try {
    bytes = await (await getStorageAdapter()).read(key, cap);
  } catch (err) {
    if (err instanceof ObjectMissing) return rejected("expired");
    if (err instanceof ObjectTooLarge) return { kind: "too_large", cap };
    return { kind: "read_failed", err };
  }
  try {
    return { kind: "ok", text: decodeTransferBody(bytes) };
  } catch (err) {
    if (!(err instanceof TransferDecodeError)) throw err;
    return rejected(err.reason);
  }
}

/**
 * Take one user's read lock, waiting for it: try again every
 * `read_lock_retry_ms` until `read_lock_wait_seconds` have passed, so two
 * references of one user arriving together are read one after the other.
 * @param lock - The lock's Redis key.
 * @param token - This request's token, which the release checks.
 * @returns True when the lock was taken; false once the wait ran out.
 * @throws {Error} When Redis fails.
 */
async function acquireReadLock(lock: string, token: string): Promise<boolean> {
  const { read_lock_seconds, read_lock_wait_seconds, read_lock_retry_ms } = getStorageConfig().transfer;
  const deadline = Date.now() + read_lock_wait_seconds * 1000;
  for (;;) {
    if ((await getRedis().set(lock, token, "EX", read_lock_seconds, "NX")) === "OK") return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(read_lock_retry_ms, left));
  }
}

/**
 * Check a transfer reference and read the body it names, at most once and
 * with at most one read in flight per user.
 * @param route - Which route's cap applies.
 * @param key - The referenced key.
 * @param userId - Who is asking.
 * @returns What the read came to.
 * @throws {Error} When Redis fails, or decoding fails for a reason other than the file's content.
 */
export async function readTransferReference(
  route: TransferRoute,
  key: string,
  userId: string,
): Promise<TransferReadResult> {
  if (!key.startsWith(TRANSFER_KEY_PREFIX)) return rejected("bad_key");

  const lock = readLockKey(userId);
  const token = randomUUID();
  if (!(await acquireReadLock(lock, token))) return { kind: "busy" };
  try {
    return await readLocked(route, key, userId);
  } finally {
    await getRedis().eval(RELEASE_LOCK_SCRIPT, 1, lock, token);
  }
}
