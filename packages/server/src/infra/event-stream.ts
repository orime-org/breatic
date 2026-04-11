/**
 * Redis Streams publisher for the event bus.
 *
 * Replaces the previous Redis Pub/Sub mechanism with a durable
 * stream. Messages survive Collab restarts — the consumer resumes
 * from the last processed stream id after reconnect.
 *
 * The transport is intentionally generic: the caller provides the
 * stream key and a JSON-serializable payload. Payload schemas live
 * with their domain (e.g. task-results in `collab/src/schema.ts`).
 */

import type Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

/** Stream key for task-result events (replaces pub/sub channel of same name). */
export function taskResultsStreamKey(): string {
  return `${env.ENV}:stream:task-results`;
}

/**
 * Publish a single JSON-serializable payload to a Redis stream.
 *
 * Uses one `payload` field so future payload extensions never
 * require a stream schema migration — the consumer parses the same
 * field on its side.
 *
 * @param redis - Connected ioredis instance
 * @param streamKey - Target stream key
 * @param payload - JSON-serializable payload object
 */
export async function publishToStream(
  redis: Redis,
  streamKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = await redis.xadd(
    streamKey,
    "*",
    "payload",
    JSON.stringify(payload),
  );
  logger.debug({ streamKey, id }, "stream_event_published");
}
