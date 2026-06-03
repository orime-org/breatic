// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { env } from "@core/config/env.js";

/**
 * Build the Redis stream key for task lifecycle events.
 * @returns the environment-scoped `task-events` stream key
 */
export function taskEventsStreamKey(): string {
  return `${env.ENV}:stream:task-events`;
}

/**
 * Build the Redis stream key for project-lifecycle commands (delete /
 * duplicate) forwarded from the transactional outbox to collab.
 *
 * Kept here as the single source of truth so the server-side relay
 * (publisher) and the collab consumer never drift on the key.
 * @returns the environment-scoped `project-lifecycle` stream key
 */
export function lifecycleStreamKey(): string {
  return `${env.ENV}:stream:project-lifecycle`;
}

/**
 * JSON replacer that preserves `undefined` values as the sentinel string
 * `"__undefined__"`. Standard `JSON.stringify` silently drops `undefined`
 * values, which would strip `handlingBy: undefined` from
 * `NodeStateUpdateEvent.update` and prevent the Collab consumer from
 * calling `dataMap.delete("handlingBy")` on the node-state-update path.
 *
 * The consumer (`task-listener.ts`) converts `"__undefined__"` back to
 * `undefined` before calling `dataMap.delete(key)`.
 * @param _key - the property key being serialized (unused; replacer keys by value)
 * @param value - the property value being serialized
 * @returns the original value, or the `"__undefined__"` sentinel when the value is `undefined`
 */
function jsonReplacerPreserveUndefined(
  _key: string,
  value: unknown,
): unknown {
  return value === undefined ? "__undefined__" : value;
}

/**
 * Publish a single JSON-serializable payload to a Redis stream.
 *
 * Uses one `payload` field so future payload extensions never
 * require a stream schema migration — the consumer parses the same
 * field on its side.
 * @param redis - Connected ioredis instance
 * @param streamKey - Target stream key
 * @param payload - JSON-serializable payload object
 */
export async function publishToStream(
  redis: Redis,
  streamKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await redis.xadd(
    streamKey,
    "MAXLEN",
    "~",
    "10000",
    "*",
    "payload",
    JSON.stringify(payload, jsonReplacerPreserveUndefined),
  );
}

/**
 * Publish a typed canvas node event to the dedicated stream.
 *
 * Enforces the `NodeEvent` union at the call site so publishers
 * cannot drift from the schema the Collab consumer expects.
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
