// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Redis-backed sliding window rate limiter.
 *
 * Uses sorted sets with timestamp scores for a sliding window approach.
 */

import type Redis from "ioredis";
import { env } from "@core/config/env.js";

/**
 * Check if a request is allowed under the rate limit.
 * @param redis - ioredis client
 * @param key - Rate limit key (e.g. `"login:{ip}"`)
 * @param maxRequests - Maximum requests allowed in the window
 * @param windowSeconds - Sliding window duration in seconds
 * @param opts - How a failed count is treated.
 * @param opts.strict - Throw when any pipelined command failed. ioredis
 *   reports a command's error inside `exec()`'s results and resolves anyway,
 *   which without this counts as zero requests and lets the request through.
 * @returns `true` if allowed, `false` if rate-limited
 * @throws {Error} With `strict`, when a pipelined command failed or no results came back.
 */
export async function checkRateLimit(
  redis: Redis,
  key: string,
  maxRequests: number,
  windowSeconds: number,
  opts: { strict?: boolean } = {},
): Promise<boolean> {
  const fullKey = `${env.ENV}:ratelimit:${key}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(fullKey, 0, windowStart);
  pipeline.zcard(fullKey);
  pipeline.zadd(fullKey, now.toString(), `${now}:${Math.random()}`);
  pipeline.expire(fullKey, windowSeconds);

  const results = await pipeline.exec();
  if (opts.strict) {
    const failed = results === null ? new Error("rate limit pipeline returned no results") : results.find(([err]) => err)?.[0];
    if (failed) throw failed;
  }
  const count = (results?.[1]?.[1] as number) ?? 0;

  return count < maxRequests;
}
