// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * @returns `true` if allowed, `false` if rate-limited
 */
export async function checkRateLimit(
  redis: Redis,
  key: string,
  maxRequests: number,
  windowSeconds: number,
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
  const count = (results?.[1]?.[1] as number) ?? 0;

  return count < maxRequests;
}
