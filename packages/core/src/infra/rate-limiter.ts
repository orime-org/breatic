// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Redis-backed sliding window rate limiter (inner#1478).
 *
 * Each quota is a sorted set of admitted requests scored by time. A request
 * names every quota it falls under, and one script run judges them together:
 * when any is full the request is refused and nothing is written, so a refused
 * request never takes up room in a window; otherwise one entry is added to
 * each. The script reads Redis `TIME`, so every instance counts on one clock.
 */

import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { env } from "@core/config/env.js";

/** One limit a request falls under. */
export interface RateLimitQuota {
  /** The quota's key, e.g. `"login:{ip}"`; the env prefix is added here. */
  key: string;
  /** Requests admitted within the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** The verdict on one request. */
export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * KEYS = the quotas' sorted sets. ARGV[1] = the entry this request adds to
 * each; then, per quota, its max and window in milliseconds. Returns {1} when
 * admitted, or {0, the longest wait in milliseconds} when refused.
 */
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local wait = 0
for i, key in ipairs(KEYS) do
  local max = tonumber(ARGV[i * 2])
  local window = tonumber(ARGV[i * 2 + 1])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  if redis.call('ZCARD', key) >= max then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local left = tonumber(oldest[2]) + window - now
    if left > wait then wait = left end
  end
end
if wait > 0 then return {0, wait} end
for i, key in ipairs(KEYS) do
  redis.call('ZADD', key, now, ARGV[1])
  redis.call('PEXPIRE', key, tonumber(ARGV[i * 2 + 1]))
end
return {1}
`;

/**
 * Judge a request against every quota it falls under, and record it in each
 * when all of them have room.
 * @param redis - ioredis client
 * @param quotas - The quotas the request falls under; at least one.
 * @returns Admitted, or refused with the seconds until every full quota has
 *   room again (at least 1).
 * @throws {Error} When the script fails (Redis unreachable, script error).
 */
export async function checkRateLimit(
  redis: Redis,
  quotas: readonly RateLimitQuota[],
): Promise<RateLimitVerdict> {
  const keys = quotas.map((q) => `${env.ENV}:ratelimit:${q.key}`);
  const args = quotas.flatMap((q) => [String(q.max), String(q.windowSeconds * 1000)]);
  const reply = (await redis.eval(SCRIPT, keys.length, ...keys, randomUUID(), ...args)) as [number, number?];
  if (reply[0] === 1) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((reply[1] ?? 0) / 1000)) };
}
