// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Task lifecycle event listener backed by Redis Streams.
 *
 * Consumes `NodeTaskCountsEvent` payloads from the `${env}:stream:task-events`
 * stream and writes them onto the target node inside the project's per-Space
 * canvas Yjs document.
 *
 * Data path:
 *   server → Redis Streams → task-listener → Hocuspocus openDirectConnection
 *   → applyNodeTaskCounts
 *
 * Collab executes; it does not judge (#186, design §3.5). Which task moved,
 * what the counts now are, whether a result rides along — all of it was decided
 * on the server, which is the only side that can see the task table. There is
 * no compare-and-set here and nothing that can be applied to the wrong row:
 * the document holds four numbers, and the event carries all four.
 *
 * Durable resume — the last handled stream id is persisted to Redis so a
 * Collab restart never drops in-flight events.
 *
 * Doc layout: `project-{pid}/canvas-{spaceId}`, one canvas doc per Space. The
 * server computes the docName from the task's spaceId; this listener accepts
 * only that shape and rejects everything else.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import type * as Y from "yjs";
import type { NodeTaskCountsEvent, NodeEvent } from "@breatic/shared";
import { parseDocName } from "@breatic/shared";
import { createLogger, taskEventsStreamKey } from "@breatic/core";
import { startStreamConsumer } from "@collab/services/event-stream.js";
import { applyNodeTaskCounts } from "@collab/services/node-task-counts.js";

const logger = createLogger("task-listener");

/**
 * Build the Redis key where this consumer persists its last-handled
 * stream id for durable resume.
 * @param envPrefix - Namespace for this consumer's cursor key (`ENV`).
 * @returns The `{envPrefix}:collab:task-events:last-id` resume-cursor key.
 */
function taskEventsLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:task-events:last-id`;
}

/**
 * Carry a counts event to the canvas document it names and apply it.
 *
 * Repeating an event lands the same numbers, so a stream redelivery is safe.
 *
 * A docName that is not a canvas Space is skipped rather than thrown on: the
 * stream consumer retries whatever throws, which would turn one unroutable
 * payload into a loop that blocks every event behind it. Failing to open the
 * document is the opposite case — a transient one — so it bubbles and the
 * consumer picks the event up again.
 * @param hocuspocus - Running Hocuspocus server, used to open a direct
 *   connection to the target canvas doc.
 * @param event - What the server recounted after a task changed state.
 * @throws {Error} when the document cannot be opened or the write fails.
 */
export async function handleNodeTaskCountsEvent(
  hocuspocus: Hocuspocus,
  event: NodeTaskCountsEvent,
): Promise<void> {
  const parsed = parseDocName(event.docName);
  if (!parsed || parsed.kind !== "canvas") {
    logger.warn(
      { docName: event.docName, type: event.type },
      "Unknown docName pattern (expected project-{pid}/canvas-{sid}), skipping",
    );
    return;
  }

  let connection: Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;
  try {
    connection = await hocuspocus.openDirectConnection(event.docName, {
      context: { user: { id: "system" }, source: "task-listener" },
    });
  } catch (err) {
    logger.error(
      { err, docName: event.docName, nodeId: event.nodeId },
      "Failed to open direct connection to Yjs doc; event will retry",
    );
    throw err;
  }

  try {
    await connection.transact((doc: Y.Doc) => {
      applyNodeTaskCounts(doc, event);
    });
  } finally {
    await connection.disconnect();
  }

  logger.info(
    { docName: event.docName, nodeId: event.nodeId, counts: event.counts },
    "Node task counts updated",
  );
}

/**
 * Route an incoming `NodeEvent` to its handler.
 * @param hocuspocus - Running Hocuspocus server forwarded to the handler.
 * @param event - Incoming node event read off the task-events stream.
 */
async function handleNodeEvent(
  hocuspocus: Hocuspocus,
  event: NodeEvent,
): Promise<void> {
  if (event.type === "node-task-counts") {
    await handleNodeTaskCountsEvent(hocuspocus, event);
    return;
  }
  // Unreachable with the current union, but a new event type added in shared/
  // reaches this listener before its handler does; say so rather than drop it.
  logger.warn({ type: (event as { type: string }).type }, "Unknown event type, skipping");
}

/**
 * Start listening for task lifecycle events on the Redis stream.
 * @param hocuspocus - Running Hocuspocus server instance
 * @param streamRedisUrl - Redis URL for Streams (DB 2)
 * @param envPrefix - `ENV`, the namespace the last-id cursor key lives in.
 *   It MUST match the namespace of the stream key (which core derives from
 *   `ENV` too) — a cursor renamed out from under a running deployment reads
 *   as "missing", and a missing cursor replays the stream from `0-0`.
 * @returns Cleanup function to stop listening
 */
export function startTaskListener(
  hocuspocus: Hocuspocus,
  streamRedisUrl: string,
  envPrefix: string,
): () => Promise<void> {
  const streamKey = taskEventsStreamKey();
  const lastIdKey = taskEventsLastIdKey(envPrefix);

  logger.info({ streamKey }, "Task event listener starting");

  const stopStream = startStreamConsumer<NodeEvent>({
    redisUrl: streamRedisUrl,
    streamKey,
    lastIdKey,
    parse: (raw) => JSON.parse(raw) as NodeEvent,
    handle: (event) => handleNodeEvent(hocuspocus, event),
  });

  return async () => {
    await stopStream();
    logger.info("Task event listener stopped");
  };
}
