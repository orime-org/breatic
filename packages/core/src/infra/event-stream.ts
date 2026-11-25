// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Redis Streams publisher for the task event bus.
 *
 * Messages survive Collab restarts: collab reads each stream as a consumer
 * group, so an entry stays pending until an instance acknowledges it.
 *
 * Streams:
 *   `${env}:stream:task-events` — a node's task counts, published by the
 *   server and the Worker whenever a task changes state. Consumed by the
 *   Collab service and routed to the target Yjs document by the event's
 *   `docName` field.
 *   `${env}:stream:project-lifecycle` — project duplicate / archive /
 *   restore commands, forwarded by the server's outbox relay.
 *
 * The low-level `publishToStream` remains generic so future event
 * types can reuse the same transport without adding new helpers.
 */

import type Redis from "ioredis";
import type { DocumentUploadEvent, FocusImageUploadEvent, NodeEvent } from "@breatic/shared";
import type { TimelineUploadEvent } from "@breatic/shared/space-content";
import { env } from "@core/config/env.js";

/** Approximate length cap of every stream we write, dead-letter streams included. */
export const STREAM_MAXLEN = 10_000;

/**
 * Build the Redis stream key for task lifecycle events.
 * @returns the environment-scoped `task-events` stream key
 */
export function taskEventsStreamKey(): string {
  return `${env.ENV}:stream:task-events`;
}

/**
 * Build the Redis stream key for project-lifecycle commands (duplicate /
 * archive / restore) forwarded from the transactional outbox to collab.
 *
 * Kept here as the single source of truth so the server-side relay
 * (publisher) and the collab consumer never drift on the key.
 * @returns the environment-scoped `project-lifecycle` stream key
 */
export function lifecycleStreamKey(): string {
  return `${env.ENV}:stream:project-lifecycle`;
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
    STREAM_MAXLEN,
    "*",
    "payload",
    JSON.stringify(payload),
  );
}

/**
 * Publish a Space placeholder's upload state for collab to write into it: a Document body block (breatic#1574) or a
 * Timeline upload clip (inner#1709).
 * @param redis - Redis client for the stream DB.
 * @param event - The upload's event.
 * @returns Nothing.
 * @throws {Error} When the stream rejects the entry.
 */
export async function publishSpaceUploadEvent(
  redis: Redis,
  event: DocumentUploadEvent | TimelineUploadEvent,
): Promise<void> {
  await publishToStream(
    redis,
    taskEventsStreamKey(),
    event as unknown as Record<string, unknown>,
  );
}

/**
 * Publish a step of a focus crop's upload for collab to write into its node (#1580).
 * @param redis - Redis client for the stream DB.
 * @param event - The step.
 * @returns Nothing.
 * @throws {Error} When the stream rejects the entry.
 */
export async function publishFocusImageUploadEvent(
  redis: Redis,
  event: FocusImageUploadEvent,
): Promise<void> {
  await publishToStream(
    redis,
    taskEventsStreamKey(),
    event as unknown as Record<string, unknown>,
  );
}

/**
 * Publish a typed canvas node event to the dedicated stream.
 *
 * Enforces the `NodeEvent` union at the call site so publishers
 * cannot drift from the schema the Collab consumer expects.
 * @param redis - Connected ioredis instance
 * @param event - The node event to publish
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
