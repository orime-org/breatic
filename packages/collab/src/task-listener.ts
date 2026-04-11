/**
 * Task result listener backed by Redis Streams.
 *
 * Subscribes to the `${env}:stream:task-results` stream via the
 * shared `startStreamConsumer` loop. When a Worker completes a
 * task, this listener updates the corresponding canvas Yjs
 * document via a Hocuspocus direct connection.
 *
 * Durable resume — the last handled stream id is persisted to
 * Redis so that a Collab restart never drops in-flight events.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import pino from "pino";
import { startStreamConsumer } from "./event-stream.js";
import {
  canvasDocName,
  NodeStatus,
  type TaskResultMessage,
} from "./schema.js";

const logger = pino({ name: "task-listener" });

/** Full stream key for task-result events. Mirrors server's `taskResultsStreamKey`. */
function taskResultsStreamKey(envPrefix: string): string {
  return `${envPrefix}:stream:task-results`;
}

/** Redis key persisting the last handled stream id. */
function taskResultsLastIdKey(envPrefix: string): string {
  return `${envPrefix}:collab:task-results:last-id`;
}

/**
 * Start listening for task results on the Redis stream and writing
 * them into the canvas Yjs document.
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
  const streamKey = taskResultsStreamKey(envPrefix);
  const lastIdKey = taskResultsLastIdKey(envPrefix);

  logger.info({ streamKey }, "Task result listener starting");

  return startStreamConsumer<TaskResultMessage>({
    redisUrl,
    streamKey,
    lastIdKey,
    parse: (raw) => JSON.parse(raw) as TaskResultMessage,
    handle: (msg) => handleTaskResult(hocuspocus, msg),
  });
}

/**
 * Handle a single task result by writing to the canvas Yjs document.
 *
 * @param hocuspocus - Hocuspocus server instance
 * @param msg - Task result message from Redis stream
 */
async function handleTaskResult(
  hocuspocus: Hocuspocus,
  msg: TaskResultMessage,
): Promise<void> {
  const docName = canvasDocName(msg.projectId);

  const connection = await hocuspocus.openDirectConnection(docName, {
    context: {
      user: { id: msg.userId },
      source: "worker",
      taskId: msg.taskId,
    },
  });

  try {
    await connection.transact((doc) => {
      const nodes = doc.getMap("nodes");
      const existing = nodes.get(msg.nodeId) as Record<string, unknown> | undefined;

      // Only update if this task is still the active one
      if (existing?.taskId && existing.taskId !== msg.taskId) {
        logger.debug(
          { nodeId: msg.nodeId, activeTask: existing.taskId, receivedTask: msg.taskId },
          "Skipping stale task result (node has newer active task)",
        );
        return;
      }

      if (msg.status === "running") {
        nodes.set(msg.nodeId, {
          ...existing,
          status: NodeStatus.GENERATING,
          taskId: msg.taskId,
        });
      } else if (msg.status === "completed") {
        nodes.set(msg.nodeId, {
          ...existing,
          status: NodeStatus.COMPLETED,
          taskId: msg.taskId,
          resultUrl: msg.result?.url ?? msg.result?.text,
          model: msg.result?.model,
          cost: msg.result?.cost,
          errorMessage: undefined,
        });
      } else if (msg.status === "failed") {
        nodes.set(msg.nodeId, {
          ...existing,
          status: NodeStatus.FAILED,
          taskId: msg.taskId,
          errorMessage: msg.error ?? "Unknown error",
        });
      }
    });

    logger.info(
      { docName, nodeId: msg.nodeId, taskId: msg.taskId, status: msg.status },
      "Canvas node updated via Yjs",
    );
  } finally {
    await connection.disconnect();
  }
}
