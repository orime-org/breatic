// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer reference (inner#1006): the three routes that can legitimately
 * carry more than the request body limit (`/canvas/paste`,
 * `/canvas/node-history/snapshot`, `/chat/message`) also take
 * `{ "transfer": "<storageKey>" }`, naming a transfer file the caller just
 * uploaded. This reads the body back out of it and hands the route's own
 * `validate` the original request, so nothing after it changes.
 *
 * A reference reads only the caller's own finished, fresh transfer, at most
 * once; one user has one read in flight at a time, so "read, then claim"
 * cannot hand one file out twice. A failure the file's own content causes
 * (too large, not a transfer file, not UTF-8) uses the reference up as well,
 * so the same bad file cannot make us read it again and again; a failure that
 * is not the file's (missing object, storage error) leaves it usable.
 *
 * The two Redis keys below are written nowhere else.
 */

import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import {
  env,
  getRedis,
  getStorageAdapter,
  getStorageConfig,
  logger,
  ObjectMissing,
  ObjectTooLarge,
  type StorageConfig,
} from "@breatic/core";
import { uploadGrantRepo } from "@breatic/domain";
import { decodeTransferBody, formatBytes, t, TransferDecodeError } from "@breatic/shared";
import type { AuthVariables } from "@server/middleware/auth.js";

/** A route that takes a transfer reference, named as in `config/storage.yaml`. */
export type TransferRoute = keyof StorageConfig["transfer"]["route_max_bytes"];

/** Why a reference was refused with 400; logged, never sent. */
type RejectReason =
  | "bad_key"
  | "not_found"
  | "not_owner"
  | "not_finished"
  | "expired"
  | "already_used"
  | "bad_format"
  | "bad_encoding";

/**
 * Every transfer key starts with this. It is bound to the bucket's lifecycle
 * rule and the public domain's block on the prefix, so it is not configurable.
 */
const TRANSFER_KEY_PREFIX = "transfer/";

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
 * The key a body references, when it is exactly `{ "transfer": "<string>" }`.
 * @param text - The request body.
 * @returns The key, or undefined for any other body.
 */
function referencedKey(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the route's own validate answers it.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "transfer") return undefined;
  const value = (parsed as { transfer: unknown }).transfer;
  return typeof value === "string" ? value : undefined;
}

/**
 * Refuse a reference with the one sentence every refusal shares, logging why.
 * @param c - The request context.
 * @param reason - Why.
 * @param fields - What else names the refusal in the log.
 * @returns The 400 answer.
 */
function reject(c: Context, reason: RejectReason, fields: Record<string, unknown>): Response {
  logger.warn({ reason, ...fields }, "transfer_rejected");
  return c.json({ error: { code: 400, message: t("server.error.transfer_invalid") } }, 400);
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
 * Check the reference and read the body back, holding the user's read lock.
 * @param c - The request context.
 * @param route - Which route's cap applies.
 * @param key - The referenced key.
 * @param userId - Who is asking.
 * @returns The body text, or the answer that refuses the reference.
 */
async function readReferenced(
  c: Context,
  route: TransferRoute,
  key: string,
  userId: string,
): Promise<string | Response> {
  const { transfer } = getStorageConfig();
  const ctx = { key, userId };

  const grant = await uploadGrantRepo.findGrantByKey(key);
  if (grant === null || grant.assetSource !== "transfer") return reject(c, "not_found", ctx);
  if (grant.userId !== userId) return reject(c, "not_owner", { ...ctx, ownerId: grant.userId });
  if (grant.consumedAt === null || grant.voidedAt !== null) return reject(c, "not_finished", ctx);
  if (Date.now() - grant.consumedAt.getTime() > transfer.reference_ttl_seconds * 1000) {
    return reject(c, "expired", ctx);
  }
  if ((await getRedis().exists(refKey(key))) === 1) return reject(c, "already_used", ctx);

  const cap = Math.min(transfer.route_max_bytes[route], grant.declaredSize);
  let bytes: Uint8Array;
  try {
    bytes = await (await getStorageAdapter()).read(key, cap);
  } catch (err) {
    if (err instanceof ObjectMissing) return reject(c, "expired", ctx);
    if (err instanceof ObjectTooLarge) {
      if (!(await claim(key, transfer.reference_ttl_seconds))) return reject(c, "already_used", ctx);
      logger.warn({ ...ctx, cap }, "transfer_too_large");
      return c.json(
        { error: { code: 413, message: t("server.error.payload_too_large", { limit: formatBytes(cap) }) } },
        413,
      );
    }
    logger.error({ err, key, userId }, "transfer_read_failed");
    return c.json({ error: { code: 502, message: t("server.error.internal") } }, 502);
  }

  let text: string;
  try {
    text = decodeTransferBody(bytes);
  } catch (err) {
    if (!(err instanceof TransferDecodeError)) throw err;
    if (!(await claim(key, transfer.reference_ttl_seconds))) return reject(c, "already_used", ctx);
    return reject(c, err.reason, ctx);
  }
  if (!(await claim(key, transfer.reference_ttl_seconds))) return reject(c, "already_used", ctx);
  return text;
}

/**
 * Accept `{ "transfer": "<storageKey>" }` on a route in place of its body.
 * Mount after the route's rate limit and before its `validate`; any other
 * body passes through untouched.
 * @param route - Which route this is, for its read cap.
 * @returns The middleware.
 */
export function acceptTransferBody(route: TransferRoute): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const key = referencedKey(await c.req.text());
    if (key === undefined) return next();
    const userId = c.get("user").id;
    if (!key.startsWith(TRANSFER_KEY_PREFIX)) return reject(c, "bad_key", { key, userId });

    const lock = readLockKey(userId);
    const token = randomUUID();
    const locked = await getRedis().set(lock, token, "EX", getStorageConfig().transfer.read_lock_seconds, "NX");
    if (locked !== "OK") {
      c.header("Retry-After", "1");
      return c.json({ error: { code: 429, message: t("server.error.rate_limited") } }, 429);
    }
    let read: string | Response;
    try {
      read = await readReferenced(c, route, key, userId);
    } finally {
      await getRedis().eval(RELEASE_LOCK_SCRIPT, 1, lock, token);
    }
    if (read instanceof Response) return read;

    // The route's validate reads the original body, as JSON: hono's validator
    // refuses a body without this content type.
    const raw = c.req.raw;
    const headers = new Headers(raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    c.req.raw = new Request(raw.url, {
      method: raw.method,
      headers,
      body: read,
      // Kept so a stream answering this request still hears the client leave.
      signal: raw.signal,
      duplex: "half",
    } as RequestInit);
    c.req.bodyCache = {};
    await next();
  };
}
