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
  /**
   * Terminal-completion timestamp (epoch ms). BullMQ sets `finishedOn` for
   * EVERY terminal failure and ONLY terminal failures — verified against
   * bullmq@5.30.0 source: `moveToFailed`'s non-retry branch assigns
   * `this.finishedOn` (retry branches leave it undefined), and the
   * stalled-death path (`moveStalledJobsToWait-9.lua`, HMSET finishedOn)
   * sets it too WITHOUT incrementing attemptsMade. So `finishedOn` is the
   * reliable "no more retries" signal across both paths; `attemptsMade`
   * is NOT (a stalled death leaves it un-incremented).
   */
  finishedOn?: number;
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
  // Only reclaim on a TERMINAL failure. BullMQ's 'failed' event also fires
  // for retryable attempts (worker.js emits after every moveToFailed) — and
  // writing idle then would fight the upcoming retry. `finishedOn` is set
  // iff the job is truly done (both the processJob non-retry branch and the
  // stalled-death Lua set it; a pending retry leaves it undefined). The
  // earlier `attemptsMade < attempts` gate was WRONG: a stalled death — the
  // primary case this net targets — moves to failed WITHOUT incrementing
  // attemptsMade, so that gate skipped exactly the deaths it should catch.
  if (!job.finishedOn) return 0;

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
