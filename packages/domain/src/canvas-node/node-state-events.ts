// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Publishing a node's task counts back to the canvas.
 *
 * Only collab may write canvas Yjs state, so every backend that moves a task
 * says so through a `node-task-counts` event on the cross-service stream,
 * which collab consumes and applies.
 *
 * Two backends send them. The worker announces a finished generation; the
 * server announces a finished upload once the ingest Worker reports the bytes
 * landed. They carry the same shape because they are the same statement about
 * a node — which is why this lives here rather than in either service.
 */

import { publishNodeEvent, type getStreamRedis } from "@breatic/core";
import type { NodeTaskCounts, NodeTaskResult } from "@breatic/shared";

/**
 * Publish a node's four task counts (#186, design §3.4).
 *
 * One event covers every state change, because the canvas document holds
 * only the four numbers. Which task moved is not on the wire, so nothing
 * here can be applied to the wrong row and there is no gen to check: a
 * number is either the current one or an older one, and the next state
 * change on that node replaces it outright.
 * @param streamRedis - Redis client for the stream DB.
 * @param docName - Canvas doc the node lives in.
 * @param nodeId - The node these counts belong to.
 * @param counts - All four, freshly counted from `node_tasks`.
 * @param result - The five content fields, on the transition into `done`
 *   and on no other.
 */
export async function emitNodeTaskCounts(
  streamRedis: ReturnType<typeof getStreamRedis>,
  docName: string,
  nodeId: string,
  counts: NodeTaskCounts,
  result?: NodeTaskResult,
): Promise<void> {
  await publishNodeEvent(streamRedis, {
    type: "node-task-counts",
    docName,
    nodeId,
    counts,
    ...(result !== undefined && { result }),
  });
}
