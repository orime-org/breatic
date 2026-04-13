/**
 * Redis client singleton (ioredis).
 *
 * Provides the main application Redis connection. BullMQ uses its own
 * separate connection configured in {@link ./queue.ts}.
 */

import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

let _redis: Redis | null = null;

/**
 * Get the singleton Redis client.
 *
 * @returns The shared ioredis instance
 */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    _redis.on("error", (err) => {
      logger.error({ err }, "Redis connection error");
    });
  }
  return _redis;
}

/**
 * Close the Redis connection.
 *
 * Call during graceful shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
