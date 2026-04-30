/**
 * Task lifecycle event listener backed by Redis Streams.
 *
 * Consumes `NodeStateUpdateEvent` payloads from the
 * `${env}:stream:task-events` stream and applies partial updates to
 * the target node's `data` Y.Map inside the project's single Yjs document.
 *
 * Data path:
 *   Worker → Redis Streams → task-listener → Hocuspocus openDirectConnection
 *   → doc.transact('node-state-update') → nodesMap.get(nodeId).get("data").set(field, value)
 *
 * Durable resume — the last handled stream id is persisted to Redis
 * so a Collab restart never drops in-flight events.
 *
 * There is one document per project (`project-{projectId}`).
 */

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import type { CanvasNodeFields, NodeStateUpdateEvent, NodeEvent } from "@breatic/shared";
import { startStreamConsumer } from "./event-stream.js";
import { parseProjectDocName } from "./schema.js";
import { createLogger } from "./logger.js";

const logger = createLogger("task-listener");

/**
 * Keys of `CanvasNodeFields['data']` that the Worker is permitted to set.
 *
 * This allowlist prevents:
 *   - adversarial overwrite of stable fields (e.g., `name`, `sourceNodeId`)
 *   - silent type corruption of fields owned by the frontend
 *
 * `handlingBy: undefined` clears the field via Y.Map.delete — safe and
 * intentional for the handling→idle success/failure transition.
 */
const WORKER_UPDATABLE_FIELDS = new Set<keyof CanvasNodeFields["data"]>([
  "state",
  "content",
  "cover_url",
  "errorMessage",
  "width",
  "height",
  "duration",
  "handlingBy",
] as const);

function taskEventsStreamKey(envPrefix: string): string {
  return `${envPrefix}:stream:task-events`;
}

function taskEventsLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:task-events:last-id`;
}

/**
 * Apply a `NodeStateUpdateEvent` to the target project Yjs document.
 *
 * Targets `nodesMap.get(event.nodeId).get("data")` directly and merges
 * `event.update` (a `Partial<CanvasNodeFields['data']>`) into it field-by-field.
 *
 * Only fields listed in `WORKER_UPDATABLE_FIELDS` are applied; unknown
 * or disallowed keys are dropped with a warn-level log.
 *
 * For each allowed key:
 *   - if value is `undefined` → `dataMap.delete(key)` (clears handlingBy on transition)
 *   - if value is defined → `dataMap.set(key, value)`
 *
 * The field-merge loop is wrapped in `doc.transact('node-state-update')`
 * so all key updates are broadcast to collaborators as a single atomic
 * Yjs update, preventing intermediate-state observations.
 *
 * Idempotent — applying the same update twice produces the same
 * result (Y.Map set/delete is last-write-wins), so stream redelivery is safe.
 */
export async function handleNodeStateUpdateEvent(
  hocuspocus: Hocuspocus,
  event: NodeStateUpdateEvent,
): Promise<void> {
  // Guard: forward-compat for future unknown event types
  if ((event as { type: string }).type !== "node-state-update") {
    logger.warn(
      { type: (event as { type: string }).type },
      "Unknown event type, skipping",
    );
    return;
  }

  // Debug trace at the top, before any async work
  logger.debug({
    docName: event.docName,
    nodeId: event.nodeId,
    updateKeys: Object.keys(event.update),
  }, "node-state-update received");

  // Validate docName — only project-{id} documents are routed here
  if (!parseProjectDocName(event.docName)) {
    logger.warn(
      { docName: event.docName, type: event.type },
      "Unknown docName pattern (expected project-{id}), skipping",
    );
    return;
  }

  // Build allowlist-filtered update BEFORE opening the connection to avoid
  // an unnecessary Doc load when there is nothing to apply.
  const filteredEntries: Array<[string, unknown]> = [];
  const droppedKeys: string[] = [];
  for (const [k, v] of Object.entries(event.update)) {
    if (WORKER_UPDATABLE_FIELDS.has(k as keyof CanvasNodeFields["data"])) {
      filteredEntries.push([k, v]);
    } else {
      droppedKeys.push(k);
    }
  }
  if (droppedKeys.length > 0) {
    logger.warn(
      {
        docName: event.docName,
        nodeId: event.nodeId,
        droppedKeys,
      },
      "node-state-update event included disallowed update keys; dropped",
    );
  }
  if (filteredEntries.length === 0) {
    // Nothing allowed to apply — skip without opening the document.
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

      // Wrap the multi-field merge in a single Yjs transaction so all key
      // updates are broadcast as one atomic update. Without this, each
      // dataMap.set/delete() emits a separate Yjs update and collaborators
      // can observe intermediate states (e.g., state='idle' before handlingBy cleared).
      // The 'node-state-update' origin lets UndoManager filter server-side writes.
      doc.transact(() => {
        for (const [k, v] of filteredEntries) {
          if (v === undefined) {
            // Worker sends handlingBy: undefined to clear it on idle transition.
            dataMap.delete(k);
          } else {
            dataMap.set(k, v);
          }
        }
      }, "node-state-update");

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
        updateKeys: filteredEntries.map(([k]) => k),
      },
      "Node state updated",
    );
  }
}

/**
 * Route incoming `NodeEvent` to the appropriate handler.
 *
 * Currently only `NodeStateUpdateEvent` is in the union, but the guard
 * is explicit for forward-compatibility.
 */
async function handleNodeEvent(
  hocuspocus: Hocuspocus,
  event: NodeEvent,
): Promise<void> {
  if (event.type === "node-state-update") {
    await handleNodeStateUpdateEvent(hocuspocus, event);
    return;
  }
  // Unreachable with current NodeEvent union, but kept for forward
  // compatibility — when a new event type is added in shared/, this
  // guard logs unknown types instead of silently dropping them.
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
