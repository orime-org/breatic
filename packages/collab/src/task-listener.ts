/**
 * Canvas node event listener backed by Redis Streams.
 *
 * Consumes `NodeEvent` payloads from the canvas-nodes stream and
 * updates the corresponding canvas Yjs document via a Hocuspocus
 * direct connection. Replaces the previous `TaskResultMessage`
 * consumer — this one writes to the authoritative frontend Yjs
 * structure (`canvas: Y.Map { nodes: Node[] }`) instead of the
 * stale top-level `nodes` map.
 *
 * Durable resume — the last handled stream id is persisted to
 * Redis so a Collab restart never drops in-flight events.
 *
 * Event handling:
 *   handling   → set state=handling, handlingBy on the matching node
 *   completed  → set state=idle, update content (+ cover_url for videos),
 *                clear handlingBy, release the Redis node lock
 *   failed     → set state=idle, clear handlingBy, release the Redis
 *                node lock. content is NOT touched.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import Redis from "ioredis";
import pino from "pino";
import type { NodeEvent } from "@breatic/shared";
import { startStreamConsumer } from "./event-stream.js";
import { canvasDocName } from "./schema.js";

const logger = pino({ name: "task-listener" });

/** Stream key for canvas node events — must match server's `canvasNodeStreamKey()`. */
function canvasNodeStreamKey(envPrefix: string): string {
  return `${envPrefix}:stream:canvas-nodes`;
}

/** Redis key where Collab persists the last handled stream id. */
function canvasNodeLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:canvas-nodes:last-id`;
}

/** Redis key for a canvas node lock — must match server's `nodeLockKey()`. */
function nodeLockKey(envPrefix: string, projectId: string, nodeId: string): string {
  return `${envPrefix}:canvas:lock:${projectId}:${nodeId}`;
}

/**
 * Minimal row shape for a canvas node as stored in the Yjs document.
 *
 * The frontend stores `canvas.nodes` as a plain JS array (not a
 * Y.Array); each entry looks like `{ id, type, position, data }`.
 * The Collab service only touches `data.*` fields it owns.
 */
interface YjsCanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ReactFlow nodes carry arbitrary fields we pass through
  [key: string]: any;
}

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

  // A dedicated Redis client for lock release — kept separate from
  // the stream consumer client so its BLOCK calls don't interfere.
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

/**
 * Apply a single NodeEvent to the canvas Yjs document.
 *
 * Idempotent — retried safely if the stream redelivers.
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
      const rawNodes = canvasMap.get("nodes") as YjsCanvasNode[] | undefined;
      if (!Array.isArray(rawNodes)) {
        logger.warn(
          { docName, nodeId: event.nodeId, type: event.type },
          "canvas.nodes is not an array, skipping update",
        );
        return;
      }

      const idx = rawNodes.findIndex((n) => n?.id === event.nodeId);
      if (idx === -1) {
        logger.warn(
          { docName, nodeId: event.nodeId, type: event.type },
          "Node not found in canvas.nodes, skipping update",
        );
        return;
      }

      const existing = rawNodes[idx]!;
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
        // failed — leave content/cover_url untouched, just clear the lock state
        nextData.state = "idle";
        delete nextData.handlingBy;
      }

      const newNode: YjsCanvasNode = { ...existing, data: nextData };
      const newNodes = [...rawNodes];
      newNodes[idx] = newNode;

      // Whole-array replacement matches how the frontend writes the
      // canvas map today (plain JS array wrapped in Y.Map.set). Not
      // CRDT-optimal, but the frontend concurrency story for node
      // data is handled by the Redis lock, not by Yjs merge semantics.
      canvasMap.set("nodes", newNodes);
      updated = true;
    });
  } finally {
    await connection.disconnect();
  }

  // Release the Redis node lock for completed/failed events so the
  // node is available for the next operation. handling events hold
  // the lock — it was taken by the API at /canvas/tasks or
  // /assets/upload/prepare time.
  if (event.type === "completed" || event.type === "failed") {
    const key = nodeLockKey(envPrefix, event.projectId, event.nodeId);
    await lockRedis.del(key);
  }

  logger.info(
    { docName, nodeId: event.nodeId, type: event.type, updated },
    "Canvas node event handled",
  );
}
