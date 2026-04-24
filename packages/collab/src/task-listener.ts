/**
 * Task lifecycle event listener backed by Redis Streams.
 *
 * Consumes `NodeEvent` payloads from the `${env}:stream:task-events`
 * stream and routes each event to the correct Yjs document + field
 * layout based on `event.docName`:
 *
 *   - `project-{id}/canvas` → main canvas
 *       `doc.getMap("canvas").get("nodesMap").get(nodeId) → data Y.Map`
 *   - `project-{id}/node/{hostNodeId}` → mixed editor (image/video/audio
 *      sub-canvas)
 *       `doc.getMap("flow").get(nodeId) → data Y.Map`
 *
 * Durable resume — the last handled stream id is persisted to Redis
 * so a Collab restart never drops in-flight events.
 *
 * Renamed from the earlier canvas-only listener when node-editor
 * documents joined as additional write targets. The Hocuspocus
 * `openDirectConnection` mechanism handles the "nobody connected"
 * case identically for either doc shape — the server-side
 * persistence extension loads the doc from PostgreSQL on demand.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import Redis from "ioredis";
import * as Y from "yjs";
import type { NodeEvent } from "@breatic/shared";
import { startStreamConsumer } from "./event-stream.js";
import { parseDocName, type ParsedDocName } from "./schema.js";
import { createLogger } from "./logger.js";

const logger = createLogger("task-listener");

function taskEventsStreamKey(envPrefix: string): string {
  return `${envPrefix}:stream:task-events`;
}

function taskEventsLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:task-events:last-id`;
}

function nodeLockKey(envPrefix: string, projectId: string, nodeId: string): string {
  return `${envPrefix}:canvas:lock:${projectId}:${nodeId}`;
}

/**
 * Apply a single NodeEvent to the target Yjs document.
 *
 * Routes by `event.docName`:
 *   - canvas docs walk `canvas.nodesMap.get(nodeId).data`
 *   - nodeEditor docs walk `flow.get(nodeId).data`
 *
 * Idempotent — safe to retry on stream redelivery.
 */
async function handleNodeEvent(
  hocuspocus: Hocuspocus,
  lockRedis: Redis,
  envPrefix: string,
  event: NodeEvent,
): Promise<void> {
  const parsed = parseDocName(event.docName);
  if (!parsed) {
    logger.warn(
      { docName: event.docName, nodeId: event.nodeId, type: event.type },
      "Unknown docName pattern, skipping",
    );
    return;
  }

  const connection = await hocuspocus.openDirectConnection(event.docName, {
    context: {
      user: { id: event.type === "handling" ? event.actor.userId : "system" },
      source: "event-stream",
    },
  });

  let updated = false;
  try {
    await connection.transact((doc) => {
      const dataMap = resolveNodeDataMap(doc, parsed, event);
      if (!dataMap) return;
      applyEventToDataMap(dataMap, event);
      updated = true;
    });
  } finally {
    await connection.disconnect();
  }

  // Release the Redis node lock — verified: only the task that holds
  // the lock can release it (Lua CAS checks taskId). Locks are
  // per-project scoped, so we use the parsed `projectId` rather than
  // the raw docName.
  if (event.type === "completed" || event.type === "failed") {
    const key = nodeLockKey(envPrefix, parsed.projectId, event.nodeId);
    const lockValue = await lockRedis.get(key);
    if (lockValue) {
      try {
        const lock = JSON.parse(lockValue) as { taskId?: string };
        if (lock.taskId === event.taskId) {
          await lockRedis.del(key);
        } else {
          logger.warn(
            { key, eventTaskId: event.taskId, lockTaskId: lock.taskId },
            "Lock held by different task, refusing to release",
          );
        }
      } catch {
        // Corrupt lock value — delete it
        await lockRedis.del(key);
      }
    }
  }

  logger.info(
    { docName: event.docName, nodeId: event.nodeId, type: event.type, updated },
    "Task event handled",
  );
}

/**
 * Locate (and lazily migrate) the target node's `data` Y.Map inside
 * the loaded Y.Doc. Returns `null` when the node isn't present — the
 * caller then silently skips the event (expected when a task resolves
 * for a node the user has since deleted).
 */
function resolveNodeDataMap(
  doc: Y.Doc,
  parsed: ParsedDocName,
  event: NodeEvent,
): Y.Map<unknown> | null {
  if (parsed.kind === "canvas") {
    const canvasMap = doc.getMap("canvas");
    const nodesMap = canvasMap.get("nodesMap");
    if (!(nodesMap instanceof Y.Map)) {
      logger.warn(
        { docName: event.docName, nodeId: event.nodeId, type: event.type },
        "canvas.nodesMap is not a Y.Map, skipping",
      );
      return null;
    }
    const nodeMap = nodesMap.get(event.nodeId);
    if (!(nodeMap instanceof Y.Map)) {
      logger.warn(
        { docName: event.docName, nodeId: event.nodeId, type: event.type },
        "Canvas node not found in nodesMap, skipping",
      );
      return null;
    }
    return ensureDataMap(nodeMap, event);
  }

  // parsed.kind === "nodeEditor" — mixed editor (image/video/audio)
  // sub-canvas. Uses a flat `flow: Y.Map<nodeId, Y.Map>` schema
  // (see packages/web/src/hooks/useMixedEditorYjsInternal.ts doc).
  const flow = doc.getMap("flow");
  if (!(flow instanceof Y.Map)) {
    logger.warn(
      { docName: event.docName, nodeId: event.nodeId, type: event.type },
      "flow is not a Y.Map, skipping",
    );
    return null;
  }
  const nodeMap = flow.get(event.nodeId);
  if (!(nodeMap instanceof Y.Map)) {
    logger.warn(
      { docName: event.docName, nodeId: event.nodeId, type: event.type },
      "Mixed editor node not found in flow, skipping",
    );
    return null;
  }
  return ensureDataMap(nodeMap, event);
}

/**
 * Legacy safety: upgrade a plain JS `data` value to a Y.Map in place.
 *
 * Older canvas docs occasionally stored `data` as a plain object
 * instead of a Y.Map. We silently migrate when first touched so the
 * downstream mutation always operates on a Y.Map.
 */
function ensureDataMap(nodeMap: Y.Map<unknown>, event: NodeEvent): Y.Map<unknown> {
  const existing = nodeMap.get("data");
  if (existing instanceof Y.Map) return existing as Y.Map<unknown>;

  logger.warn(
    { docName: event.docName, nodeId: event.nodeId, type: event.type },
    "Migrating legacy node data (plain → Y.Map)",
  );
  const oldData = (existing ?? {}) as Record<string, unknown>;
  const newDataMap = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(oldData)) {
    newDataMap.set(k, v);
  }
  nodeMap.set("data", newDataMap);
  return newDataMap;
}

/**
 * Apply the event's state transition to a node's `data` Y.Map. Same
 * shape for canvas and mixed editor — both use the `state` /
 * `handlingBy` / `content` / `coverUrl` / `lastEventType` contract.
 */
function applyEventToDataMap(dataMap: Y.Map<unknown>, event: NodeEvent): void {
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
    dataMap.set("lastEventType", "completed");
    dataMap.delete("handlingBy");
  } else {
    // failed — content untouched
    dataMap.set("lastEventType", "failed");
    dataMap.set("state", "idle");
    dataMap.delete("handlingBy");
  }
}

/**
 * Start listening for task lifecycle events on the Redis stream.
 *
 * @param hocuspocus - Running Hocuspocus server instance
 * @param streamRedisUrl - Redis URL for Streams (DB 2)
 * @param lockRedisUrl - Redis URL for canvas lock operations (DB 0)
 * @param envPrefix - Environment prefix for stream + last-id keys
 * @returns Cleanup function to stop listening
 */
export function startTaskListener(
  hocuspocus: Hocuspocus,
  streamRedisUrl: string,
  lockRedisUrl: string,
  envPrefix: string,
): () => Promise<void> {
  const streamKey = taskEventsStreamKey(envPrefix);
  const lastIdKey = taskEventsLastIdKey(envPrefix);

  const lockRedis = new Redis(lockRedisUrl);

  logger.info({ streamKey }, "Task event listener starting");

  const stopStream = startStreamConsumer<NodeEvent>({
    redisUrl: streamRedisUrl,
    streamKey,
    lastIdKey,
    parse: (raw) => JSON.parse(raw) as NodeEvent,
    handle: (event) => handleNodeEvent(hocuspocus, lockRedis, envPrefix, event),
  });

  return async () => {
    await stopStream();
    await lockRedis.quit();
    logger.info("Task event listener stopped");
  };
}
