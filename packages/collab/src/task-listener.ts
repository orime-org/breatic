/**
 * Canvas node event listener backed by Redis Streams.
 *
 * Consumes `NodeEvent` payloads from the canvas-nodes stream and
 * updates the corresponding canvas Yjs document via a Hocuspocus
 * direct connection.
 *
 * The canvas document uses the Map-of-Maps structure:
 *
 *   canvas.nodesMap: Y.Map<nodeId, Y.Map>
 *
 * Each node is an independent Y.Map. The listener looks up the
 * target node by ID (O(1)) and sets individual fields — no array
 * copy, no collateral impact on other nodes.
 *
 * Durable resume — the last handled stream id is persisted to
 * Redis so a Collab restart never drops in-flight events.
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

/**
 * Apply a single NodeEvent to the canvas Yjs document.
 *
 * Looks up the node in `canvas.nodesMap` by ID and sets the
 * relevant fields directly on the node's Y.Map.
 *
 * Idempotent — safe to retry on stream redelivery.
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
      const nodesMap = canvasMap.get("nodesMap");

      if (!(nodesMap instanceof Y.Map)) {
        logger.warn(
          { docName, nodeId: event.nodeId, type: event.type },
          "canvas.nodesMap is not a Y.Map, skipping",
        );
        return;
      }

      const nodeMap = nodesMap.get(event.nodeId);
      if (!(nodeMap instanceof Y.Map)) {
        logger.warn(
          { docName, nodeId: event.nodeId, type: event.type },
          "Node not found in nodesMap, skipping",
        );
        return;
      }

      const dataMap = nodeMap.get("data");
      if (!(dataMap instanceof Y.Map)) {
        logger.warn(
          { docName, nodeId: event.nodeId, type: event.type },
          "Node missing nested data Y.Map, skipping",
        );
        return;
      }

      if (event.type === "handling") {
        dataMap.set("state", "handling");
        let handlingBy = dataMap.get("handlingBy");
        if (!(handlingBy instanceof Y.Map)) {
          handlingBy = new Y.Map();
          dataMap.set("handlingBy", handlingBy);
        }
        (handlingBy as Y.Map<unknown>).set("userId", event.actor.userId);
        (handlingBy as Y.Map<unknown>).set("username", event.actor.username);
      } else if (event.type === "completed") {
        dataMap.set("state", "idle");
        dataMap.set("content", event.content);
        if (event.cover_url !== undefined) {
          dataMap.set("coverUrl", event.cover_url);
        }
        dataMap.delete("handlingBy");
      } else {
        // failed — content untouched
        dataMap.set("state", "idle");
        dataMap.delete("handlingBy");
      }

      updated = true;
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

/**
 * Start listening for canvas node events on the Redis stream.
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
