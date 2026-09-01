// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Publishing a node's state back to the canvas.
 *
 * Only collab may write canvas Yjs state, so every backend that finishes work
 * on a node says so through one of these: a `node-state-update` event on the
 * cross-service stream, which collab consumes and applies.
 *
 * Two backends send them. The worker announces a finished generation; the
 * server announces a finished upload once the ingest Worker reports the bytes
 * landed. They carry the same shape because they are the same statement about
 * a node — which is why these live here rather than in either service.
 *
 * Every event carries the lease `gen`. Collab CAS-checks it against the node's
 * live `handlingBy.gen` before applying, so a write-back that lost its lease
 * while it was working cannot clobber whoever holds it now.
 */

import { publishNodeEvent, type getStreamRedis } from "@breatic/core";

/** Content fields that may appear in a success NodeStateUpdateEvent. */
export interface NodeStateDoneFields {
  /** Permanent URL of the generated asset. */
  content: string;
  /** Optional cover/thumbnail URL (video first-frame, 3D preview, etc.). */
  coverUrl?: string;
  /** Image / video pixel width. */
  width?: number;
  /** Image / video pixel height. */
  height?: number;
  /** Video / audio duration in seconds. */
  duration?: number;
}

/**
 * Publish a `node-state-update` event with state "idle" (success) for a
 * single node.
 *
 * Extracted for testability. Called from Stage 4 of `runTask` after a
 * successful persist. Errors are swallowed by the caller.
 *
 * `handlingBy` is explicitly set to `null` so the Collab consumer
 * deletes the key from the node's data Y.Map (clearing the actor badge).
 * null is used instead of undefined because JSON.stringify strips undefined.
 * @param streamRedis - Redis client for the stream DB
 * @param docName - Project doc name (e.g. "project-{projectId}")
 * @param nodeId - Canvas node receiving the update
 * @param contentFields - Content fields to write into the node's data map
 * @param gen - Lease gen this write-back belongs to (#1580 #7); collab
 *   CAS-checks it against the node's live handlingBy.gen before applying.
 */
export async function emitNodeStateDone(
  streamRedis: ReturnType<typeof getStreamRedis>,
  docName: string,
  nodeId: string,
  contentFields: NodeStateDoneFields,
  gen: number,
): Promise<void> {
  await publishNodeEvent(streamRedis, {
    type: "node-state-update",
    docName,
    nodeId,
    gen,
    update: {
      state: "idle",
      content: contentFields.content,
      coverUrl: contentFields.coverUrl,
      width: contentFields.width,
      height: contentFields.height,
      duration: contentFields.duration,
      // null survives JSON.stringify (undefined is stripped).
      // The Collab consumer calls Y.Map.delete("handlingBy") on null.
      handlingBy: null,
      // Success MUST clear any prior error (#1569 unified handling→idle
      // contract): a node that failed a retryable attempt (errorMessage
      // written) or was reclaimed by the lease sweeper ('Operation timed
      // out') then succeeds would otherwise keep a stale error badge over
      // valid content. null → the task-listener deletes errorMessage,
      // mirroring the frontend setNodeContent's data.delete('errorMessage').
      errorMessage: null,
    },
  });
}

/**
 * Publish a `node-state-update` event with state "idle" (failure) for a
 * single node.
 *
 * Exported for unit testing.
 * @param streamRedis - Redis client for the stream DB
 * @param docName - Project doc name (e.g. "project-{projectId}")
 * @param nodeId - Canvas node receiving the update
 * @param errorMessage - Human-readable error description
 * @param gen - Lease gen this write-back belongs to (#1580 #7); collab
 *   CAS-checks it against the node's live handlingBy.gen before applying.
 */
export async function emitNodeStateFailed(
  streamRedis: ReturnType<typeof getStreamRedis>,
  docName: string,
  nodeId: string,
  errorMessage: string,
  gen: number,
): Promise<void> {
  await publishNodeEvent(streamRedis, {
    type: "node-state-update",
    docName,
    nodeId,
    gen,
    update: {
      state: "idle",
      errorMessage,
      // null survives JSON.stringify (undefined is stripped).
      // The Collab consumer calls Y.Map.delete("handlingBy") on null.
      handlingBy: null,
    },
  });
}

/**
 * Transition a node's handling lease from the queue phase to the running
 * (execution) phase (#1580 #2). Emitted at `markRunning` — the Collab
 * consumer READS the node's current handlingBy and re-stamps `phase:
 * 'running'` + a fresh server startedAt, PRESERVING the rest (the fencing
 * gen included). Carries an empty `update` — the `renewLease` signal is the
 * whole payload.
 * @param streamRedis - Redis client for the stream DB.
 * @param docName - Canvas doc the node lives in.
 * @param nodeId - Node whose lease transitions to the execution phase.
 * @param gen - Lease gen this renewal belongs to (#1580 #7); collab only
 *   restamps when it matches the node's live handlingBy.gen.
 */
export async function emitNodeLeaseRunning(
  streamRedis: ReturnType<typeof getStreamRedis>,
  docName: string,
  nodeId: string,
  gen: number,
): Promise<void> {
  await publishNodeEvent(streamRedis, {
    type: "node-state-update",
    docName,
    nodeId,
    gen,
    update: {},
    renewLease: "running",
  });
}
