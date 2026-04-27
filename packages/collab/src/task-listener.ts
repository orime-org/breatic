/**
 * Task lifecycle event listener backed by Redis Streams.
 *
 * Consumes `HistoryUpdateEvent` payloads from the
 * `${env}:stream:task-events` stream and applies partial updates to
 * the target history item inside the project's single Yjs document.
 *
 * Data path:
 *   Worker → Redis Streams → task-listener → Hocuspocus openDirectConnection
 *   → doc.transact → nodesMap.get(nodeId).get("data").get("history")[i].set(...)
 *
 * Durable resume — the last handled stream id is persisted to Redis
 * so a Collab restart never drops in-flight events.
 *
 * There is one document per project (`project-{projectId}`). The
 * legacy canvas / nodeEditor routing switch is gone.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import type { HistoryUpdateEvent, NodeEvent } from "@breatic/shared";
import { startStreamConsumer } from "./event-stream.js";
import { parseProjectDocName } from "./schema.js";
import { createLogger } from "./logger.js";

const logger = createLogger("task-listener");

function taskEventsStreamKey(envPrefix: string): string {
  return `${envPrefix}:stream:task-events`;
}

function taskEventsLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:task-events:last-id`;
}

/**
 * Apply a `HistoryUpdateEvent` to the target project Yjs document.
 *
 * Finds the history item identified by `event.historyItemId` inside
 * `nodesMap.get(nodeId).get("data").get("history")` and merges
 * `event.update` (a `Partial<HistoryItem>`) into it field-by-field.
 *
 * Idempotent — applying the same update twice produces the same
 * result (Y.Map set is last-write-wins), so stream redelivery is safe.
 */
async function handleHistoryUpdateEvent(
  hocuspocus: Hocuspocus,
  event: HistoryUpdateEvent,
): Promise<void> {
  const projectId = parseProjectDocName(event.docName);
  if (!projectId) {
    logger.warn(
      { docName: event.docName, type: event.type },
      "Unknown docName pattern (expected project-{id}), skipping",
    );
    return;
  }

  const connection = await hocuspocus.openDirectConnection(event.docName, {
    context: { user: { id: "system" }, source: "task-listener" },
  });

  let applied = false;
  try {
    await connection.transact((doc: Y.Doc) => {
      const canvasMap = doc.getMap("canvas");
      const nodesMap = canvasMap.get("nodesMap");
      if (!(nodesMap instanceof Y.Map)) {
        logger.warn(
          { docName: event.docName, nodeId: event.nodeId },
          "canvas.nodesMap is not a Y.Map, skipping",
        );
        return;
      }

      const nodeMap = nodesMap.get(event.nodeId);
      if (!(nodeMap instanceof Y.Map)) {
        // Node deleted before the task completed — expected race.
        logger.warn(
          { docName: event.docName, nodeId: event.nodeId },
          "Canvas node not found in nodesMap (deleted?), skipping",
        );
        return;
      }

      const dataMap = nodeMap.get("data");
      if (!(dataMap instanceof Y.Map)) {
        logger.warn(
          { docName: event.docName, nodeId: event.nodeId },
          "node.data is not a Y.Map, skipping",
        );
        return;
      }

      const history = dataMap.get("history");
      if (!(history instanceof Y.Array)) {
        logger.warn(
          { docName: event.docName, nodeId: event.nodeId },
          "node.data.history is not a Y.Array, skipping",
        );
        return;
      }

      const items = history.toArray() as Y.Map<unknown>[];
      const idx = items.findIndex(
        (item) => item instanceof Y.Map && item.get("id") === event.historyItemId,
      );
      if (idx < 0) {
        // History item deleted before the task completed — expected race.
        logger.warn(
          {
            docName: event.docName,
            nodeId: event.nodeId,
            historyItemId: event.historyItemId,
          },
          "History item not found (deleted?), skipping",
        );
        return;
      }

      const item = history.get(idx) as Y.Map<unknown>;
      for (const [k, v] of Object.entries(event.update)) {
        item.set(k, v);
      }
      applied = true;
    });
  } finally {
    await connection.disconnect();
  }

  if (applied) {
    logger.info(
      {
        docName: event.docName,
        nodeId: event.nodeId,
        historyItemId: event.historyItemId,
        updateKeys: Object.keys(event.update),
      },
      "History item updated",
    );
  }
}

/**
 * Route incoming `NodeEvent` to the appropriate handler.
 *
 * Currently only `HistoryUpdateEvent` is in the union, but the guard
 * is explicit for forward-compatibility.
 */
async function handleNodeEvent(
  hocuspocus: Hocuspocus,
  event: NodeEvent,
): Promise<void> {
  if (event.type === "history-update") {
    await handleHistoryUpdateEvent(hocuspocus, event);
    return;
  }
  // Unknown event type — log and skip to stay forward-compatible.
  logger.warn({ type: (event as { type: string }).type }, "Unknown event type, skipping");
}

/**
 * Start listening for task lifecycle events on the Redis stream.
 *
 * @param hocuspocus - Running Hocuspocus server instance
 * @param streamRedisUrl - Redis URL for Streams (DB 2)
 * @param envPrefix - Environment prefix for stream + last-id keys
 * @returns Cleanup function to stop listening
 */
export function startTaskListener(
  hocuspocus: Hocuspocus,
  streamRedisUrl: string,
  envPrefix: string,
): () => Promise<void> {
  const streamKey = taskEventsStreamKey(envPrefix);
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
