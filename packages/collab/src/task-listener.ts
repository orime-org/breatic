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
 * Apply a NodeEvent to the target Yjs document — unified multi-node.
 *
 * The event carries all N target nodes (N ≥ 1) and gets applied in a
 * single `connection.transact` so every node transition is atomic from
 * the collaborator's perspective. Idempotent — safe to retry on stream
 * redelivery.
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
      { docName: event.docName, type: event.type },
      "Unknown docName pattern, skipping",
    );
    return;
  }

  const targets = collectTargetNodeIds(event);
  if (targets.length === 0) {
    logger.warn(
      { docName: event.docName, type: event.type, taskId: event.taskId },
      "Event has no target nodeIds, skipping",
    );
    return;
  }

  const connection = await hocuspocus.openDirectConnection(event.docName, {
    context: {
      user: { id: event.type === "handling" ? event.actor.userId : "system" },
      source: "event-stream",
    },
  });

  let updatedCount = 0;
  try {
    await connection.transact((doc) => {
      for (const nodeId of targets) {
        const dataMap = resolveNodeDataMap(doc, parsed, event, nodeId);
        if (!dataMap) continue;
        applyEventToDataMap(dataMap, event, parsed, nodeId);
        updatedCount++;
      }
    });
  } finally {
    await connection.disconnect();
  }

  // Release the Redis node lock for each affected node. Only the task
  // that holds the lock can release it (Lua CAS checks taskId).
  if (event.type === "completed" || event.type === "failed") {
    for (const nodeId of targets) {
      const key = nodeLockKey(envPrefix, parsed.projectId, nodeId);
      const lockValue = await lockRedis.get(key);
      if (!lockValue) continue;
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
        await lockRedis.del(key);
      }
    }
  }

  logger.info(
    { docName: event.docName, type: event.type, taskId: event.taskId, targets: targets.length, updated: updatedCount },
    "Task event handled",
  );
}

function collectTargetNodeIds(event: NodeEvent): string[] {
  if (event.type === "handling") return event.nodeIds;
  if (event.type === "failed") return event.nodeIds;
  // completed
  return event.outputs.map((o) => o.nodeId);
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
  nodeId: string,
): Y.Map<unknown> | null {
  if (parsed.kind === "canvas") {
    const canvasMap = doc.getMap("canvas");
    const nodesMap = canvasMap.get("nodesMap");
    if (!(nodesMap instanceof Y.Map)) {
      logger.warn(
        { docName: event.docName, nodeId, type: event.type },
        "canvas.nodesMap is not a Y.Map, skipping",
      );
      return null;
    }
    const nodeMap = nodesMap.get(nodeId);
    if (!(nodeMap instanceof Y.Map)) {
      logger.warn(
        { docName: event.docName, nodeId, type: event.type },
        "Canvas node not found in nodesMap, skipping",
      );
      return null;
    }
    return ensureDataMap(nodeMap, event, nodeId);
  }

  // parsed.kind === "nodeEditor" — mixed editor (image/video/audio)
  // sub-canvas. Uses a flat `flow: Y.Map<nodeId, Y.Map>` schema
  // (see packages/web/src/hooks/useMixedEditorYjsInternal.ts doc).
  const flow = doc.getMap("flow");
  if (!(flow instanceof Y.Map)) {
    logger.warn(
      { docName: event.docName, nodeId, type: event.type },
      "flow is not a Y.Map, skipping",
    );
    return null;
  }
  const nodeMap = flow.get(nodeId);
  if (!(nodeMap instanceof Y.Map)) {
    logger.warn(
      { docName: event.docName, nodeId, type: event.type },
      "Mixed editor node not found in flow, skipping",
    );
    return null;
  }
  return ensureDataMap(nodeMap, event, nodeId);
}

/**
 * Legacy safety: upgrade a plain JS `data` value to a Y.Map in place.
 *
 * Older canvas docs occasionally stored `data` as a plain object
 * instead of a Y.Map. We silently migrate when first touched so the
 * downstream mutation always operates on a Y.Map.
 */
function ensureDataMap(nodeMap: Y.Map<unknown>, event: NodeEvent, nodeId: string): Y.Map<unknown> {
  const existing = nodeMap.get("data");
  if (existing instanceof Y.Map) return existing as Y.Map<unknown>;

  logger.warn(
    { docName: event.docName, nodeId, type: event.type },
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
 * Apply the event's state transition to a node's `data` Y.Map.
 *
 * Fields always touched:
 *   - `state`: 'handling' / 'idle'
 *   - `handlingBy`: created on handling, deleted on completed/failed
 *   - `errorInfo`: cleared on handling/completed, set on failed
 *   - `lastEventType`: set on completed/failed
 *
 * Doc-kind-specific behaviour:
 *   - Canvas `failed`: `content` / `coverUrl` preserved — canvas nodes
 *     are user-created entities, failing an AIGC run must not wipe
 *     the user's prior successful output.
 *   - `nodeEditor` (mixed editor) `failed`: `content` / `coverUrl`
 *     cleared — mixed-editor tiles ARE mini-tool outputs, so a failed
 *     run has no valid content to retain. The node becomes an explicit
 *     "failed placeholder" that the user deletes manually (no retry UX).
 */
function applyEventToDataMap(
  dataMap: Y.Map<unknown>,
  event: NodeEvent,
  parsed: ParsedDocName,
  nodeId: string,
): void {
  if (event.type === "handling") {
    dataMap.set("state", "handling");
    // Re-triggering a node should wipe stale failure info so the UI
    // doesn't keep showing an old error while the new run is pending.
    dataMap.delete("errorInfo");
    let handlingBy = dataMap.get("handlingBy");
    if (!(handlingBy instanceof Y.Map)) {
      handlingBy = new Y.Map();
      dataMap.set("handlingBy", handlingBy);
    }
    (handlingBy as Y.Map<unknown>).set("userId", event.actor.userId);
    (handlingBy as Y.Map<unknown>).set("username", event.actor.username);
  } else if (event.type === "completed") {
    const output = event.outputs.find((o) => o.nodeId === nodeId);
    if (!output) return;
    dataMap.set("state", "idle");
    dataMap.set("content", output.content);
    if (output.cover_url !== undefined) {
      dataMap.set("coverUrl", output.cover_url);
    }
    dataMap.set("lastEventType", "completed");
    dataMap.delete("handlingBy");
    // Success clears any lingering error from a prior failed run.
    dataMap.delete("errorInfo");
  } else {
    // failed (all-or-nothing: every nodeId in event.nodeIds fails together)
    dataMap.set("lastEventType", "failed");
    dataMap.set("state", "idle");
    dataMap.delete("handlingBy");
    dataMap.set("errorInfo", event.errorMessage ?? "");

    if (parsed.kind === "nodeEditor") {
      // Mixed-editor tile is the task's output — clear it on failure.
      dataMap.set("content", "");
      dataMap.delete("coverUrl");
    }
    // parsed.kind === "canvas": leave content/coverUrl untouched so
    // the user's prior result stays visible.
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
