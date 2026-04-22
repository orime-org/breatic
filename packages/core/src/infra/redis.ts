/**
 * Redis client singletons (ioredis).
 *
 * Three logical connections, each backed by a separate Redis DB:
 *
 * | Singleton        | ENV Key            | DB  | Purpose                              |
 * |------------------|--------------------|-----|--------------------------------------|
 * | getRedis()       | REDIS_URL          | /0  | Session, lock, rate-limit, health    |
 * | getQueueRedis()  | REDIS_QUEUE_URL    | /1  | BullMQ task queue                    |
 * | getStreamRedis() | REDIS_STREAM_URL   | /2  | Redis Streams + Hocuspocus pub/sub   |
 *
 * Early stage: all three can point to the same Redis instance (different DBs).
 * At scale: swap URLs to independent Redis instances without code changes.
 */

import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

// ── General (DB 0) ───────────────────────────────────────────────

let _redis: Redis | null = null;

/**
 * Get the general-purpose Redis client (session, lock, rate-limit).
 *
 * @returns The shared ioredis instance for DB 0
 */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    _redis.on("error", (err) => {
      logger.error({ err }, "Redis (general) connection error");
    });
  }
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

// ── Queue (DB 1) ─────────────────────────────────────────────────

let _queueRedis: Redis | null = null;

/**
 * Get the BullMQ Redis client.
 *
 * @returns The shared ioredis instance for DB 1
 */
export function getQueueRedis(): Redis {
  if (!_queueRedis) {
    _queueRedis = new Redis(env.REDIS_QUEUE_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    _queueRedis.on("error", (err) => {
      logger.error({ err }, "Redis (queue) connection error");
    });
  }
  return _queueRedis;
}

export async function closeQueueRedis(): Promise<void> {
  if (_queueRedis) {
    await _queueRedis.quit();
    _queueRedis = null;
  }
}

// ── Stream (DB 2) ────────────────────────────────────────────────

let _streamRedis: Redis | null = null;

/**
 * Get the Streams / Hocuspocus pub-sub Redis client.
 *
 * @returns The shared ioredis instance for DB 2
 */
export function getStreamRedis(): Redis {
  if (!_streamRedis) {
    _streamRedis = new Redis(env.REDIS_STREAM_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    _streamRedis.on("error", (err) => {
      logger.error({ err }, "Redis (stream) connection error");
    });
  }
  return _streamRedis;
}

export async function closeStreamRedis(): Promise<void> {
  if (_streamRedis) {
    await _streamRedis.quit();
    _streamRedis = null;
  }
}
