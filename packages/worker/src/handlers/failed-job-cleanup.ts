// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Node write-back safety net for jobs BullMQ judged dead (#1569 hole ②;
 * made cross-process in #1580 #6).
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
 * back. This net closes that.
 *
 * WHY CROSS-PROCESS (#1580 #6): the crashed-worker case CANNOT be handled
 * by that worker's own `worker.on('failed')` — a dead process runs no
 * callback. So the net is driven by BullMQ `QueueEvents` 'failed'
 * ({@link reclaimFailedJobById}), which every LIVE instance receives, so
 * some live instance always does the write-back. (Detecting the death is
 * BullMQ's own job: its stalled-checker — which needs at least one live
 * worker in the fleet to run `moveStalledJobsToWait` — moves a crashed
 * job to the failed set. If the WHOLE fleet is down nothing runs here, and
 * the collab handling-lease sweeper (1h budget) is the final backstop.)
 *
 * Idempotent by construction: the write-back is the standard failure
 * patch (idle + errorMessage + handlingBy:null) applied by the collab
 * task-listener; re-applying it to an already-idle node is harmless.
 */
import type { getStreamRedis } from "@breatic/core";
import { projectActivitiesRepo, publishActivityNew } from "@breatic/core";
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

  const { projectId, spaceId, targetNodeIds, nodeGens } = job.data;
  if (!projectId) return 0;
  // Crash-net activity row: the worker that died never reached its
  // in-handler failure path, so the feed would silently lose the
  // outcome. Idempotent on taskId - when the in-handler path DID run
  // (plain terminal failure, every live instance also receives this
  // broadcast), the partial UNIQUE turns this into a no-op.
  try {
    const inserted = await projectActivitiesRepo.insertIgnoreDuplicateTask({
      projectId,
      actorUserId: job.data.userId,
      type: "generation:failed",
      spaceId: spaceId ?? null,
      nodeId:
        targetNodeIds && targetNodeIds.length === 1 ? targetNodeIds[0] : null,
      taskId: job.data.taskId,
      payload: {
        source: job.data.source ?? "task",
        ...(job.data.toolName !== undefined && { toolName: job.data.toolName }),
        executedOn: "backend",
        errorMessage: `Task failed: ${reason}`,
      },
    });
    if (inserted) await publishActivityNew(projectId);
  } catch {
    // Best-effort: the node write-backs below are the critical part;
    // the caller (application entry) logs stream-level failures.
  }
  if (!spaceId) return 0;
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
        // #1580 #7: echo the node's lease gen so the collab CAS accepts the
        // reclaim only while this job's lease is still live. 0 (never a
        // valid gen) marks a producer bug; collab drops it with a warn.
        nodeGens?.[nodeId] ?? 0,
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

/** Read-side queue shape: fetch a job by id (satisfied by BullMQ `Queue`). */
export interface JobFetcher {
  /**
   * Fetch a job by id, or `undefined` if it no longer exists. Terminally
   * failed jobs are retained by `removeOnFail.age` (24h, see
   * `defaultJobOpts`), so a job is fetchable right after its failure event.
   */
  getJob(jobId: string): Promise<FailedJobLike | undefined>;
}

/**
 * Cross-process failed-job write-back (#1580 #6). BullMQ `QueueEvents`
 * 'failed' delivers only `{ jobId, failedReason }` — NOT the job payload —
 * to every LIVE instance. This handler re-fetches the job (retained by
 * `removeOnFail`) for its `data` + terminal `finishedOn`, then delegates to
 * {@link cleanupFailedJobNodes} (which no-ops unless the failure is
 * terminal).
 *
 * Runs once per subscribed instance per failed job (QueueEvents broadcasts):
 * the write-back is idempotent, and the fencing gen (#1580 #7) makes any
 * stale write a no-op. That redundancy is the price of crash-resilience —
 * the instance whose worker died runs no callback, but every OTHER live
 * instance still cleans the node up.
 * @param queue - Read-side fetcher (a BullMQ `Queue`) resolving the job id.
 * @param streamRedis - Redis client for the stream DB.
 * @param jobId - The failed job's id from the `QueueEvents` 'failed' event.
 * @param reason - BullMQ failure reason, embedded in the node error message.
 * @returns the number of nodes a write-back was successfully published for.
 */
export async function reclaimFailedJobById(
  queue: JobFetcher,
  streamRedis: ReturnType<typeof getStreamRedis>,
  jobId: string,
  reason: string,
): Promise<number> {
  const job = await queue.getJob(jobId);
  return cleanupFailedJobNodes(streamRedis, job, reason);
}
