/**
 * Redis Streams publisher for the task event bus.
 *
 * Replaces the previous Redis Pub/Sub mechanism with a durable
 * stream. Messages survive Collab restarts — the consumer resumes
 * from the last processed stream id after reconnect.
 *
 * Current stream:
 *   `${env}:stream:task-events` — history-update events published
 *   by the Worker (on task completion / failure). Consumed by the
 *   Collab service and routed to the target Yjs document by the
 *   event's `docName` field.
 *
 * Renamed from `${env}:stream:canvas-nodes` when node-editor
 * documents joined as additional write targets — the name now
 * reflects the actual payload scope (task lifecycle events, not
 * canvas-only node events).
 *
 * The low-level `publishToStream` remains generic so future event
 * types can reuse the same transport without adding new helpers.
 */

import type Redis from "ioredis";
import type { NodeEvent } from "@breatic/shared";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

/** Stream key for task lifecycle events. */
export function taskEventsStreamKey(): string {
  return `${env.ENV}:stream:task-events`;
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
    "MAXLEN",
    "~",
    "10000",
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
 * @param event - `HistoryUpdateEvent` payload
 */
export async function publishNodeEvent(
  redis: Redis,
  event: NodeEvent,
): Promise<void> {
  await publishToStream(
    redis,
    taskEventsStreamKey(),
    event as unknown as Record<string, unknown>,
  );
}
