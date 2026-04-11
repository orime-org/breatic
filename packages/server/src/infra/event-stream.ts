/**
 * Redis Streams publisher for the canvas node event bus.
 *
 * Replaces the previous Redis Pub/Sub mechanism with a durable
 * stream. Messages survive Collab restarts — the consumer resumes
 * from the last processed stream id after reconnect.
 *
 * Current stream:
 *   `${env}:stream:canvas-nodes` — handling / completed / failed
 *   events published by the API (on task creation / upload lock)
 *   and by the Worker (on task completion / failure). Consumed by
 *   the Collab service to update canvas Yjs documents.
 *
 * The low-level `publishToStream` remains generic so future event
 * types can reuse the same transport without adding new helpers.
 */

import type Redis from "ioredis";
import type { NodeEvent } from "@breatic/shared";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

/** Stream key for canvas node state events. */
export function canvasNodeStreamKey(): string {
  return `${env.ENV}:stream:canvas-nodes`;
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

/**
 * Publish a typed canvas node event to the dedicated stream.
 *
 * Enforces the `NodeEvent` union at the call site so publishers
 * cannot drift from the schema the Collab consumer expects.
 *
 * @param redis - Connected ioredis instance
 * @param event - `NodeEvent` union payload (handling / completed / failed)
 */
export async function publishNodeEvent(
  redis: Redis,
  event: NodeEvent,
): Promise<void> {
  await publishToStream(
    redis,
    canvasNodeStreamKey(),
    event as unknown as Record<string, unknown>,
  );
}
