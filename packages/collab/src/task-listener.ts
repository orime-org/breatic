/**
 * Task lifecycle event listener backed by Redis Streams (v10 multi-doc).
 *
 * Consumes `NodeStateUpdateEvent` payloads from the
 * `${env}:stream:task-events` stream and applies partial updates to
 * the target node's `data` Y.Map inside the project's per-Space
 * canvas Yjs document.
 *
 * Data path:
 *   Worker → Redis Streams → task-listener → Hocuspocus openDirectConnection
 *   → doc.transact('node-state-update') → nodesMap.get(nodeId).get("data").set(field, value)
 *
 * Durable resume — the last handled stream id is persisted to Redis
 * so a Collab restart never drops in-flight events.
 *
 * v10 doc layout: `project-{pid}/canvas-{spaceId}` (one canvas doc
 * per Space). Worker computes the docName from `task.spaceId`; this
 * listener accepts only that shape and rejects everything else.
 * `nodesMap` lives at the top level of the canvas doc (not nested
 * under a `canvas` wrapper Map).
 */

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import type { CanvasNodeFields, NodeStateUpdateEvent, NodeEvent } from "@breatic/shared";
import { parseDocName } from "@breatic/shared";
import { startStreamConsumer } from "./event-stream.js";
import { createLogger } from "./logger.js";

const logger = createLogger("task-listener");

/**
 * Keys of `CanvasNodeFields['data']` that the Worker is permitted to set.
 *
 * This allowlist prevents:
 *   - adversarial overwrite of stable fields (e.g., `name`, `sourceNodeId`)
 *   - silent type corruption of fields owned by the frontend
 *
 * `handlingBy: null` clears the field via Y.Map.delete — safe and
 * intentional for the handling→idle success/failure transition.
 * null is used (not undefined) because JSON.stringify strips undefined keys.
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

  // Payload-shape guards (audit #133). Every `return` below intentionally
  // *skips* the event — i.e. the stream consumer treats the handler as
  // successful and moves on. We do not throw on permanently-broken payloads
  // because the stream consumer retries on throw (no-ack), which would
  // turn a single corrupt event into an infinite-retry loop that blocks
  // every subsequent event on the same stream.
  if (typeof event.nodeId !== "string" || event.nodeId.length === 0) {
    logger.warn(
      { docName: event.docName, nodeId: event.nodeId },
      "node-state-update event missing or invalid nodeId, skipping",
    );
    return;
  }
  if (
    event.update === null ||
    typeof event.update !== "object" ||
    Array.isArray(event.update)
  ) {
    logger.warn(
      { docName: event.docName, nodeId: event.nodeId, update: event.update },
      "node-state-update event has malformed update payload, skipping",
    );
    return;
  }

  // Debug trace after shape guards — keys lookup is safe now.
  logger.debug({
    docName: event.docName,
    nodeId: event.nodeId,
    updateKeys: Object.keys(event.update),
  }, "node-state-update received");

  // Validate docName — only canvas-Space docs are routed here.
  // The Worker emits `project-{pid}/canvas-{spaceId}` for every node-
  // state update; meta / document / timeline kinds are not valid
  // routes for this listener.
  const parsed = parseDocName(event.docName);
  if (!parsed || parsed.kind !== "canvas") {
    logger.warn(
      { docName: event.docName, type: event.type },
      "Unknown docName pattern (expected project-{pid}/canvas-{sid}), skipping",
    );
    return;
  }

  // Build allowlist-filtered update BEFORE opening the connection to avoid
  // an unnecessary Doc load when there is nothing to apply.
  //
  // Sentinel decode: JSON.stringify drops `undefined` values, so the publisher
  // (event-stream.ts::publishToStream) encodes them as the string "__undefined__".
  // We decode that sentinel back to `undefined` here so the field-merge loop
  // can call `dataMap.delete(key)` for the handlingBy→undefined clear path.
  const UNDEFINED_SENTINEL = "__undefined__";
  const filteredEntries: Array<[string, unknown]> = [];
  const droppedKeys: string[] = [];
  for (const [k, v] of Object.entries(event.update)) {
    if (WORKER_UPDATABLE_FIELDS.has(k as keyof CanvasNodeFields["data"])) {
      filteredEntries.push([k, v === UNDEFINED_SENTINEL ? undefined : v]);
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

  // openDirectConnection / transact failures are *transient* (Hocuspocus
  // persistence layer hiccup, Redis pub/sub split-brain, etc.). Let them
  // bubble — the stream consumer will not-ack and retry on the next
  // iteration. We only catch to log structured context; we do NOT swallow
  // here because retry on transient failure is the desired behavior.
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

  let applied = false;
  try {
    await connection.transact((doc: Y.Doc) => {
      // v10 layout: `nodesMap` at the top level of `canvas-{sid}`.
      // Pre-v10 used `doc.getMap("canvas").get("nodesMap")` (the
      // single-doc model nested under a per-Space wrapper); that
      // wrapper is gone now that each Space has its own doc.
      const nodesMap = doc.getMap("nodesMap");

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
          if (v === undefined || v === null) {
            // Worker sends handlingBy: null to clear it on idle transition.
            // null survives JSON.stringify/parse; undefined does not.
            // Both are treated as "delete this key from the Y.Map".
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
