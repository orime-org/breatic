/**
 * Canvas node event listener backed by Redis Streams.
 *
 * Consumes `NodeEvent` payloads from the canvas-nodes stream and
 * updates the corresponding canvas Yjs document via a Hocuspocus
 * direct connection.
 *
 * **Dual-format support**: during the migration from the legacy
 * plain-JS-array structure (`canvas.nodes: Node[]`) to the new
 * Map-of-Maps structure (`canvas.nodesMap: Y.Map<nodeId, Y.Map>`),
 * this listener detects which format is present in the document and
 * writes back accordingly. Once all canvases have been migrated by
 * the frontend, the legacy path can be removed.
 *
 * Durable resume — the last handled stream id is persisted to
 * Redis so a Collab restart never drops in-flight events.
 *
 * Event handling:
 *   handling   -> set state=handling, handlingBy on the matching node
 *   completed  -> set state=idle, update content (+ coverUrl for videos),
 *                 clear handlingBy, release the Redis node lock
 *   failed     -> set state=idle, clear handlingBy, release the Redis
 *                 node lock. content is NOT touched.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import Redis from "ioredis";
import * as Y from "yjs";
import pino from "pino";
import type { NodeEvent } from "@breatic/shared";
import { startStreamConsumer } from "./event-stream.js";
import { canvasDocName } from "./schema.js";

const logger = pino({ name: "task-listener" });

function canvasNodeStreamKey(envPrefix: string): string {
  return `${envPrefix}:stream:canvas-nodes`;
}

function canvasNodeLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:canvas-nodes:last-id`;
}

function nodeLockKey(envPrefix: string, projectId: string, nodeId: string): string {
  return `${envPrefix}:canvas:lock:${projectId}:${nodeId}`;
}

// ── Legacy format helpers ─────────────────────────────────────────

/** Node shape in the legacy plain-JS-array format. */
interface LegacyCanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Apply event using the **legacy** plain-JS-array format.
 *
 * `canvas.nodes` is a plain JS array. We find the node by ID, clone
 * the array with the updated entry, and `set("nodes", newArray)`.
 */
function applyEventLegacy(
  canvasMap: Y.Map<unknown>,
  nodes: LegacyCanvasNode[],
  event: NodeEvent,
): boolean {
  const idx = nodes.findIndex((n) => n?.id === event.nodeId);
  if (idx === -1) {
    logger.warn(
      { nodeId: event.nodeId, type: event.type },
      "[legacy] Node not found in canvas.nodes, skipping",
    );
    return false;
  }

  const existing = nodes[idx]!;
  const nextData: Record<string, unknown> = { ...existing.data };

  if (event.type === "handling") {
    nextData.state = "handling";
    nextData.handlingBy = event.actor;
  } else if (event.type === "completed") {
    nextData.state = "idle";
    nextData.content = event.content;
    if (event.cover_url !== undefined) {
      nextData.cover_url = event.cover_url;
    }
    delete nextData.handlingBy;
  } else {
    nextData.state = "idle";
    delete nextData.handlingBy;
  }

  const newNodes = [...nodes];
  newNodes[idx] = { ...existing, data: nextData };
  canvasMap.set("nodes", newNodes);
  return true;
}

// ── New format helpers ────────────────────────────────────────────

/**
 * Apply event using the **new** Map-of-Maps format.
 *
 * `canvas.nodesMap` is a `Y.Map<nodeId, Y.Map>`. We look up the
 * node by ID (O(1)) and set individual fields — no array copy, no
 * collateral damage to other nodes.
 */
function applyEventNew(
  nodesMap: Y.Map<unknown>,
  event: NodeEvent,
): boolean {
  const nodeMap = nodesMap.get(event.nodeId) as Y.Map<unknown> | undefined;
  if (!nodeMap || !(nodeMap instanceof Y.Map)) {
    logger.warn(
      { nodeId: event.nodeId, type: event.type },
      "[new] Node not found in nodesMap, skipping",
    );
    return false;
  }

  if (event.type === "handling") {
    nodeMap.set("state", "handling");
    // handlingBy is a Y.Map in the new structure. If it doesn't
    // exist yet, create one; otherwise update in place.
    let handlingBy = nodeMap.get("handlingBy") as Y.Map<unknown> | undefined;
    if (!handlingBy || !(handlingBy instanceof Y.Map)) {
      handlingBy = new Y.Map<unknown>();
      nodeMap.set("handlingBy", handlingBy);
    }
    handlingBy.set("userId", event.actor.userId);
    handlingBy.set("username", event.actor.username);
  } else if (event.type === "completed") {
    nodeMap.set("state", "idle");
    nodeMap.set("content", event.content);
    if (event.cover_url !== undefined) {
      nodeMap.set("coverUrl", event.cover_url);
    }
    nodeMap.delete("handlingBy");
  } else {
    // failed — content untouched
    nodeMap.set("state", "idle");
    nodeMap.delete("handlingBy");
  }

  return true;
}

// ── Main handler ──────────────────────────────────────────────────

/**
 * Apply a single NodeEvent to the canvas Yjs document.
 *
 * Detects document format (new `nodesMap` vs legacy `nodes` array)
 * and dispatches to the appropriate writer. Idempotent — safe to
 * retry on stream redelivery.
 */
async function handleNodeEvent(
  hocuspocus: Hocuspocus,
  lockRedis: Redis,
  envPrefix: string,
  event: NodeEvent,
): Promise<void> {
  const docName = canvasDocName(event.projectId);

  const connection = await hocuspocus.openDirectConnection(docName, {
    context: {
      user: { id: event.type === "handling" ? event.actor.userId : "system" },
      source: "event-stream",
    },
  });

  let updated = false;
  try {
    await connection.transact((doc) => {
      const canvasMap = doc.getMap("canvas");

      // ── Detect format ──────────────────────────────────────────
      // New format: `nodesMap` is a Y.Map<nodeId, Y.Map>.
      // Legacy format: `nodes` is a plain JS array.
      const nodesMap = canvasMap.get("nodesMap");
      if (nodesMap instanceof Y.Map) {
        updated = applyEventNew(nodesMap as Y.Map<unknown>, event);
        return;
      }

      // Fall back to legacy format.
      const rawNodes = canvasMap.get("nodes");
      if (Array.isArray(rawNodes)) {
        updated = applyEventLegacy(canvasMap, rawNodes as LegacyCanvasNode[], event);
        return;
      }

      logger.warn(
        { docName, nodeId: event.nodeId, type: event.type },
        "canvas has neither nodesMap (new) nor nodes[] (legacy), skipping",
      );
    });
  } finally {
    await connection.disconnect();
  }

  // Release the Redis node lock for completed/failed events.
  if (event.type === "completed" || event.type === "failed") {
    const key = nodeLockKey(envPrefix, event.projectId, event.nodeId);
    await lockRedis.del(key);
  }

  logger.info(
    { docName, nodeId: event.nodeId, type: event.type, updated },
    "Canvas node event handled",
  );
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Start listening for canvas node events on the Redis stream and
 * applying them to the canvas Yjs document.
 *
 * @param hocuspocus - Running Hocuspocus server instance
 * @param redisUrl - Redis connection URL
 * @param envPrefix - Environment prefix for stream + last-id keys
 * @returns Cleanup function to stop listening
 */
export function startTaskListener(
  hocuspocus: Hocuspocus,
  redisUrl: string,
  envPrefix: string,
): () => Promise<void> {
  const streamKey = canvasNodeStreamKey(envPrefix);
  const lastIdKey = canvasNodeLastIdKey(envPrefix);

  const lockRedis = new Redis(redisUrl);

  logger.info({ streamKey }, "Canvas node event listener starting");

  const stopStream = startStreamConsumer<NodeEvent>({
    redisUrl,
    streamKey,
    lastIdKey,
    parse: (raw) => JSON.parse(raw) as NodeEvent,
    handle: (event) => handleNodeEvent(hocuspocus, lockRedis, envPrefix, event),
  });

  return async () => {
    await stopStream();
    await lockRedis.quit();
    logger.info("Canvas node event listener stopped");
  };
}
