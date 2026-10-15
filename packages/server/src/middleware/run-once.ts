// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Run a request once per press (inner#1490).
 *
 * The browser sends one `Idempotency-Key` per press and re-sends it, unchanged,
 * while it has no answer. The first arrival claims a Redis record and runs the
 * handler; a repeat while it runs gets `409`, a repeat after it finished gets
 * the stored answer back. The handler's answer, its replay and the 409 carry
 * `Idempotency-Status`, which is how the browser tells "finished" from "the
 * network or a proxy failed before we heard back"; the 400 and 422 this
 * refuses with before running carry none, and the browser takes them as final.
 *
 * The running record holds a lease renewed while the handler runs, so a slow
 * handler keeps it and a process that dies frees it within one lease. The
 * finished answer replaces the running record only while that record is still
 * this run's: a run whose lease lapsed and was taken over leaves the newer
 * record alone.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { env, getRedis, logger } from "@breatic/core";
import { IDEMPOTENCY_RETENTION_SECONDS, t, type IdempotencyScope } from "@breatic/shared";
import { getRunningLeaseMs } from "@server/config/idempotency.js";
import type { AuthVariables } from "@server/middleware/auth.js";

/** A run-once record as stored in Redis. */
type RunRecord =
  | { state: "running"; fingerprint: string; owner: string }
  | { state: "done"; fingerprint: string; status: number; body: string; contentType: string | null };

/** Returns the record when one exists, otherwise writes `running` and returns nil. */
const CLAIM_SCRIPT = `
local v = redis.call('get', KEYS[1])
if v then return v end
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
return false`;

/** Extends the lease only while the record is still this run's running record. */
const RENEW_SCRIPT = `
local v = redis.call('get', KEYS[1])
if not v then return 0 end
local r = cjson.decode(v)
if r.state ~= 'running' or r.owner ~= ARGV[1] then return 0 end
redis.call('pexpire', KEYS[1], ARGV[2])
return 1`;

/** Writes the finished answer unless another run has taken the record over. */
const FINISH_SCRIPT = `
local v = redis.call('get', KEYS[1])
if v then
  local r = cjson.decode(v)
  if r.state ~= 'running' or r.owner ~= ARGV[1] then return 0 end
end
redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;

/** Who and what a log line about one record is about. */
interface RunContext {
  userId: string;
  scope: IdempotencyScope;
  key: string;
}

/**
 * Answer with an error envelope and, when given, an `Idempotency-Status`.
 * @param c - The request context.
 * @param status - The HTTP status.
 * @param messageKey - The locale key of what the caller reads.
 * @param idempotencyStatus - The status header, when this answer has one.
 * @returns The response.
 */
function refuse(
  c: Context,
  status: 400 | 409 | 422,
  messageKey: string,
  idempotencyStatus?: "in_progress",
): Response {
  const headers: Record<string, string> = idempotencyStatus
    ? { "Idempotency-Status": idempotencyStatus }
    : {};
  return c.json({ error: { code: status, message: t(messageKey) } }, status, headers);
}

/**
 * Hand back a finished answer as it was first given.
 * @param c - The request context.
 * @param record - The finished record.
 * @returns The replayed response.
 */
function replay(c: Context, record: Extract<RunRecord, { state: "done" }>): Response {
  const headers: Record<string, string> = {
    "Idempotency-Status": "done",
    "Idempotent-Replayed": "true",
  };
  if (record.contentType) headers["Content-Type"] = record.contentType;
  return c.body(record.body, record.status as ContentfulStatusCode, headers);
}

/**
 * Keep a running record's lease alive until stopped.
 *
 * A renewal that errors is retried on the next tick; the renewer gives up only
 * when the record is no longer this run's, or when the lease it last secured
 * has run out — after that the record may already belong to someone else.
 * @param redisKey - The record's key.
 * @param owner - This run's owner token.
 * @param leaseMs - The lease length.
 * @param ctx - Who and what, for the log.
 * @returns `stop`, which clears the timer and waits for a renewal in flight.
 */
function keepLease(
  redisKey: string,
  owner: string,
  leaseMs: number,
  ctx: RunContext,
): { stop: () => Promise<void> } {
  let securedUntil = Date.now() + leaseMs;
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;

  /**
   * One renewal; never rejects.
   * @returns A promise that settles when the renewal does.
   */
  const renew = async (): Promise<void> => {
    try {
      const renewed = await getRedis().eval(RENEW_SCRIPT, 1, redisKey, owner, String(leaseMs));
      if (renewed === 1) {
        securedUntil = Date.now() + leaseMs;
        return;
      }
      stopped = true;
      clearInterval(timer);
      logger.error(ctx, "idempotency_lease_lost");
    } catch (err) {
      logger.warn({ err, ...ctx }, "idempotency_renew_failed");
      if (Date.now() > securedUntil) {
        stopped = true;
        clearInterval(timer);
        logger.error({ err, ...ctx }, "idempotency_lease_expired");
      }
    }
  };

  const timer = setInterval(() => {
    if (!stopped) inFlight = renew();
  }, Math.floor(leaseMs / 3));

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

/**
 * Store the handler's answer as the finished record and mark it done.
 *
 * A failed store is an infrastructure fault: it is logged and the answer is
 * still handed back, since the request has already done all its writes.
 * @param c - The request context, holding the handler's response.
 * @param redisKey - The record's key.
 * @param owner - This run's owner token.
 * @param fingerprint - The request body's hash.
 * @param ctx - Who and what, for the log.
 * @returns Nothing; `c.res` carries the `done` status afterwards.
 */
async function finish(
  c: Context,
  redisKey: string,
  owner: string,
  fingerprint: string,
  ctx: RunContext,
): Promise<void> {
  const record: RunRecord = {
    state: "done",
    fingerprint,
    status: c.res.status,
    body: await c.res.clone().text(),
    contentType: c.res.headers.get("Content-Type"),
  };
  try {
    const written = await getRedis().eval(
      FINISH_SCRIPT,
      1,
      redisKey,
      owner,
      JSON.stringify(record),
      String(IDEMPOTENCY_RETENTION_SECONDS[ctx.scope]),
    );
    if (written !== 1) logger.error(ctx, "idempotency_lease_lost");
  } catch (err) {
    logger.error({ err, ...ctx }, "idempotency_store_failed");
  }
  c.res.headers.set("Idempotency-Status", "done");
}

/**
 * Run the route once per `Idempotency-Key`; mount after `requireAuth` and
 * the request validators.
 * @param scope - Which run-once request this route is.
 * @returns The middleware.
 */
export function runOnce(scope: IdempotencyScope): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!key) return refuse(c, 400, "server.idempotency.missing");

    const ctx: RunContext = { userId: c.get("user").id, scope, key };
    const redisKey = `${env.REDIS_KEY_PREFIX}:server:idempotency:${ctx.userId}:${scope}:${key}`;
    const fingerprint = createHash("sha256").update(await c.req.text()).digest("hex");
    const owner = randomUUID();
    const leaseMs = getRunningLeaseMs();
    const running: RunRecord = { state: "running", fingerprint, owner };

    const existing = (await getRedis().eval(
      CLAIM_SCRIPT,
      1,
      redisKey,
      JSON.stringify(running),
      String(leaseMs),
    )) as string | null;
    if (existing !== null) {
      const record = JSON.parse(existing) as RunRecord;
      if (record.fingerprint !== fingerprint) return refuse(c, 422, "server.idempotency.mismatch");
      if (record.state === "running") {
        return refuse(c, 409, "server.idempotency.in_progress", "in_progress");
      }
      return replay(c, record);
    }

    const lease = keepLease(redisKey, owner, leaseMs, ctx);
    try {
      await next();
    } finally {
      await lease.stop();
    }
    await finish(c, redisKey, owner, fingerprint, ctx);
  };
}
