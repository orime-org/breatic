// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Node write-back safety net for jobs BullMQ judged dead (#1569 hole ②).
 *
 * `runTask`'s own failure paths emit the node failure write-back — but
 * they only run when the handler runs. Two death modes bypass them:
 *
 *   - the worker process crashed after `markRunning` (handler never
 *     finished, no catch executed);
 *   - stalled death: the job exceeded `maxStalledCount` and BullMQ moved
 *     it straight to failed without re-running the handler.
 *
 * In both, the target nodes' Yjs `state: 'handling'` was never written
 * back — a zombie the `worker.on('failed')` hook closes by calling this
 * helper. The collab handling-lease sweeper (1h budget) remains the
 * final backstop if even this event is lost.
 *
 * Idempotent by construction: the write-back is the standard failure
 * patch (idle + errorMessage + handlingBy:null) applied by the collab
 * task-listener; re-applying it to an already-idle node is harmless.
 */
import type { getStreamRedis } from "@breatic/core";
import { canvasSpaceDocName } from "@breatic/shared";
import { emitNodeStateFailed, type TaskJobData } from "@worker/handlers/dispatch.js";

/** Minimal failed-job shape (BullMQ `Job` narrowed to what we read). */
export interface FailedJobLike {
  data: TaskJobData;
  /** Attempts already consumed (BullMQ increments before 'failed' fires). */
  attemptsMade: number;
  opts: { attempts?: number };
}

/**
 * Emit the standard failure write-back for every target node of a job
 * that has FINALLY failed (no retries remaining).
 *
 * Best-effort per node: a publish failure on one node is swallowed so the
 * remaining nodes still get their write-back (the caller logs; the collab
 * sweeper is the final backstop either way).
 * @param streamRedis - Redis client for the stream DB.
 * @param job - The failed job (undefined when BullMQ lost the job reference).
 * @param reason - BullMQ failure reason, embedded in the node error message.
 * @returns the number of nodes a write-back was successfully published for.
 */
export async function cleanupFailedJobNodes(
  streamRedis: ReturnType<typeof getStreamRedis>,
  job: FailedJobLike | undefined,
  reason: string,
): Promise<number> {
  if (!job) return 0;
  // While retries remain the retry will re-drive the node — writing idle
  // now would fight the upcoming attempt. BullMQ increments attemptsMade
  // before emitting 'failed', so a finally-failed job satisfies >=.
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return 0;

  const { projectId, spaceId, targetNodeIds } = job.data;
  if (!projectId || !spaceId) return 0;
  if (!targetNodeIds || targetNodeIds.length === 0) return 0;

  const docName = canvasSpaceDocName(projectId, spaceId);
  let emitted = 0;
  for (const nodeId of targetNodeIds) {
    try {
      await emitNodeStateFailed(
        streamRedis,
        docName,
        nodeId,
        `Task failed: ${reason}`,
      );
      emitted++;
    } catch {
      // Best-effort: continue with the remaining nodes. The caller
      // (application entry) logs the failure; the collab handling-lease
      // sweeper reclaims any node this misses.
    }
  }
  return emitted;
}
