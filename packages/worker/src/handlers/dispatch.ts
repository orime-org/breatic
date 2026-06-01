/**
 * BullMQ job handlers for task execution.
 *
 * Implements 5 execution paths matching the Python worker:
 * 1. Mini-tool → direct provider call
 * 2. Understand → media analysis / ASR
 * 3. AIGC Direct → provider call with explicit params
 * 4. Skill (explicit) → AI SDK agent loop
 * 5. Skill (auto-select) → merged skills, LLM chooses
 */

import type { Job } from "bullmq";
import { generateText, stepCountIs } from "ai";
import { resolveMiniToolEntry } from "@worker/mini-tool-registry.js";
import { runLocalHandler } from "@worker/handlers/local/index.js";
import { getModel } from "@breatic/domain";
import { buildToolSet } from "@breatic/domain";
import { getSkillRegistry } from "@breatic/domain";
import { getStreamRedis } from "@breatic/core";
import { downloadAndStore, getStorageAdapter, storageKey } from "@breatic/core";
import { taskService } from "@breatic/domain";
import { creditService } from "@breatic/domain";
import { nodeHistoryService } from "@breatic/domain";
import { publishNodeEvent } from "@breatic/core";
import { verifyCanvasNodeLock, releaseCanvasNodeLock } from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import { env } from "@breatic/core";
import { logger } from "@breatic/core";
import { extractPromptText } from "@breatic/domain";

const AIGC_TASK_TYPES: Record<string, string> = {
  image: "image",
  audio: "audio",
  video: "video",
  tts: "tts",
  three_d: "three-d",
};

/** Understand default models by source type. */
const UNDERSTAND_DEFAULTS: Record<string, string> = {
  image: "gemini-flash-vi",
  video: "gemini-flash-vv",
  audio: "gemini-flash-va",
};

/** Job data shape from BullMQ. */
export interface TaskJobData {
  taskId: string;
  taskType: string;
  userId: string;
  /**
   * Project the task is scoped to. Required for any task that writes
   * back to a canvas node (v10: every canvas-bound mini-tool / AIGC
   * task is project + Space scoped). Optional only for legacy paths
   * that do not bind to a canvas node — those skip
   * `NodeStateUpdateEvent` emission entirely.
   */
  projectId?: string;
  /**
   * Space within the project the task targets. v10 multi-doc: the
   * worker writes results to `project-{projectId}/canvas-{spaceId}`.
   * Required when `projectId` is set; canvas-bound tasks must
   * always carry both. Producer is `server/routes/canvas.ts` /
   * `server/routes/mini-tools.ts`.
   */
  spaceId?: string;
  params: Record<string, unknown>;
  model?: string;
  skillName?: string;
  source?: string;
  toolName?: string;
  /**
   * Target canvas node IDs to receive the result via NodeStateUpdateEvent.
   * Length === 1 for single-output ops; length === N for multi-output ops
   * (e.g., split image → 4 nodes). Absent for tasks not bound to any canvas
   * node (understand, skill agents without node bindings).
   */
  targetNodeIds?: string[];
  /**
   * Execution mode (spec §10.13 / §10.15). Required — producer (server
   * routes) must always declare intent.
   *
   * When `'overwrite'`, the server already SETNX-locked the (single)
   * target node before enqueuing this job. The worker:
   *   1. Verifies the lock value still matches `taskId` before publishing
   *      results (TTL-expiry / reclaim defense, spec §10.15.5).
   *   2. Releases the lock in `finally` (compare-and-delete via the helper).
   *
   * `'append'` flows skip the lock entirely (the new sibling has a fresh
   * UUID, no contention possible).
   */
  mode: "append" | "overwrite";
}

/**
 * Resolve the Yjs canvas-doc name for a job, or return null when the
 * job is not bound to a canvas (no projectId / no spaceId — those
 * tasks never emit `NodeStateUpdateEvent`).
 *
 * Centralises the v10 multi-doc rule in one place: every site that
 * formerly called `projectDocName(projectId)` now goes through
 * here, guaranteeing the spaceId arrives at the doc-name builder.
 * @param projectId - Project the task is scoped to, or undefined for non-canvas tasks
 * @param spaceId - Space within the project the result is written to, or undefined for non-canvas tasks
 * @returns The `project-{projectId}/canvas-{spaceId}` doc name, or null when either id is missing
 */
function resolveCanvasDocName(
  projectId: string | undefined,
  spaceId: string | undefined,
): string | null {
  if (!projectId || !spaceId) return null;
  return canvasSpaceDocName(projectId, spaceId);
}

/**
 * Process a task job from the BullMQ queue.
 *
 * Billing policy (AIGC, non-text-generation):
 *   1. The user is charged **only** when the file is successfully
 *      persisted to permanent storage (OSS / S3 / local).
 *   2. Provider invocation may be retried (network blips, 429, etc.).
 *   3. Once the provider has returned a result, retries are forbidden
 *      — if BullMQ redelivers this job after `providerResultUrl` was
 *      recorded, we mark the task failed immediately and return.
 *   4. Each successful completion charges exactly once, enforced by a
 *      CAS on `tasks.billed_at` inside `markCompletedAndBill`.
 *
 * Execution stages:
 *   [re-entry guard] → [provider call] → [record providerResultUrl]
 *   → [persist to storage] → [markCompletedAndBill (CAS)] → [deduct]
 *
 * Errors before the provider result is recorded cause BullMQ to retry
 * the job. Errors after (persist failure, markCompleted failure) cause
 * the task to be marked failed with **no charge** — the user can re-run
 * from scratch if they want the result.
 * @param job - BullMQ job with TaskJobData payload
 * @returns Result dict on success, or a failure status marker
 */
/**
 * Public entry called by the BullMQ worker. Wraps {@link runTaskBody} with
 * a lock-management envelope:
 *
 *   - Computes `lockTargetNodeId` (only set when `mode='overwrite'` AND the
 *     job binds to exactly one canvas node — the lock granularity is per-node).
 *   - Always releases the lock in `finally`, regardless of how the body
 *     exits. The release is compare-and-delete (see `releaseCanvasNodeLock`),
 *     so it's a no-op if the TTL already expired or another task reclaimed
 *     the node.
 *
 * Spec: §10.15.5 (lock value verify before publish) + §10.15.6 (error path)
 * (Worker crash → finally block del lock; if that also fails, the TTL is
 * the safety net).
 * @param job - BullMQ job carrying the TaskJobData payload to execute
 * @returns The result dict on success, or a failure status marker (e.g. `{ failed: true, reason }`)
 */
export async function runTask(job: Job<TaskJobData>): Promise<Record<string, unknown>> {
  const { taskId, projectId, targetNodeIds, mode } = job.data;
  const lockTargetNodeId =
    mode === "overwrite" &&
    projectId &&
    targetNodeIds &&
    targetNodeIds.length === 1
      ? targetNodeIds[0]!
      : null;

  try {
    return await runTaskBody(job, lockTargetNodeId);
  } finally {
    if (lockTargetNodeId && projectId) {
      try {
        await releaseCanvasNodeLock(projectId, lockTargetNodeId, taskId);
      } catch (err) {
        // Don't propagate — release is best-effort. The TTL on the lock
        // (CANVAS_LOCK_TTL_SECONDS = 7200s) bounds the worst case.
        logger.warn(
          { err, taskId, projectId, nodeId: lockTargetNodeId },
          "release_canvas_lock_failed_will_ttl",
        );
      }
    }
  }
}

/**
 * Internal task execution body. Same logic as the original `runTask`, but
 * extracted so the public {@link runTask} wrapper can manage the canvas-node
 * lock lifecycle without indenting this body inside a `try`.
 * @param job - BullMQ job carrying the TaskJobData payload to execute
 * @param lockTargetNodeId - Non-null when this task holds an overwrite lock
 *   and should verify ownership before publishing the success event.
 * @returns The result dict on success, or a failure status marker (e.g. `{ failed: true, reason }`)
 */
async function runTaskBody(
  job: Job<TaskJobData>,
  lockTargetNodeId: string | null,
): Promise<Record<string, unknown>> {
  const { taskId, taskType, userId, projectId, spaceId, params, model, skillName, source, toolName, targetNodeIds } = job.data;
  const canvasDocName = resolveCanvasDocName(projectId, spaceId);

  const streamRedis = getStreamRedis();
  // targetNodeIds from job payload (replaces old params.node_ids / historyItemId pattern).
  // Falls back to empty array for tasks not bound to any canvas node.
  const nodeIds: string[] = targetNodeIds ?? [];

  // ─── Re-entry guard ───────────────────────────────────────────────
  // Two cases where BullMQ might redeliver a job we've already touched:
  //
  //   (a) billed_at is already set → the task completed successfully
  //       on a previous run. Idempotent no-op: preserve status and
  //       return the stored result. DO NOT mark failed — that would
  //       overwrite a legitimate `completed` status.
  //
  //   (b) provider_result_url is set but billed_at is not → the
  //       provider was invoked on a previous run but the task never
  //       reached the billing step (Worker crashed during persist,
  //       markCompletedAndBill failed, etc). Per policy, no further
  //       retries — mark failed and release the node without charging.
  const existing = await taskService.getByIdInternal(taskId);
  if (existing?.billedAt) {
    logger.info(
      { taskId, billedCredits: existing.billedCredits },
      "Task already completed + billed; returning stored result",
    );
    return (existing.result ?? { alreadyCompleted: true });
  }
  if (existing?.providerResultUrl) {
    logger.warn(
      { taskId, providerResultUrl: existing.providerResultUrl },
      "BullMQ redelivered task after provider call but before billing; failing per no-retry policy",
    );
    await taskService.markFailed(taskId, "Task retry not allowed after provider call");
    if (canvasDocName) {
      for (const nodeId of nodeIds) {
        await emitNodeStateFailed(streamRedis, canvasDocName, nodeId, "Retry not allowed after provider returned a result");
      }
    }
    return { failed: true, reason: "no_retry_after_provider" };
  }

  await taskService.markRunning(taskId, job.id ?? "");

  // ─── Stage 1: Call the provider ───────────────────────────────────
  // Errors here rethrow → BullMQ retries (this stage is retry-safe).
  let providerResult: Record<string, unknown>;
  let creditsUsed = 0;
  let resolvedSkills: string[] = [];
  const startTime = performance.now();

  try {
    if (source === "mini_tool" && toolName) {
      [providerResult, creditsUsed] = await runMiniTool({
        toolName,
        taskType,
        params,
        jobId: job.id ?? "",
        userId,
        projectId,
      });
    } else if (taskType === "understand") {
      [providerResult, creditsUsed] = await runUnderstand(model, params);
    } else if (taskType in AIGC_TASK_TYPES && !skillName) {
      [providerResult, creditsUsed] = await runAigcDirect(taskType, model, params);
    } else {
      const [text, skills] = await runSkillAgent(taskType, skillName, params);
      resolvedSkills = skills;
      try {
        providerResult = JSON.parse(text) as Record<string, unknown>;
      } catch {
        providerResult = { content: text };
      }
    }
  } catch (err) {
    // Provider call failed. Safe to retry via BullMQ — no charge yet,
    // no provider_result_url recorded. The next retry enters this
    // function fresh.
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, error: errorMsg }, "provider_call_failed");
    await taskService.markFailed(taskId, errorMsg);
    await recordFailureHistory(taskId, projectId, nodeIds, userId, model, params, errorMsg);
    if (canvasDocName) {
      for (const nodeId of nodeIds) {
        await emitNodeStateFailed(streamRedis, canvasDocName, nodeId, errorMsg);
      }
    }
    throw err; // Rethrow to let BullMQ schedule a retry (attempts > 1)
  }

  // ─── Normalize to unified outputs shape ──────────────────────────
  // Provider paths and local handlers return different shapes; we
  // collapse them here so the rest of runTask works with a single
  // `{outputs:[{url,cover_url?,extra?}], extras}` view. N=1 (provider)
  // and N>1 (local cut) flow through the same code path.
  const unified = toUnifiedOutputs(providerResult);
  if (source === "mini_tool" && nodeIds.length > 0 && unified.outputs.length !== nodeIds.length) {
    const msg = `outputs.length (${unified.outputs.length}) !== node_ids.length (${nodeIds.length})`;
    logger.error({ taskId, toolName }, msg);
    await taskService.markFailed(taskId, msg);
    await recordFailureHistory(taskId, projectId, nodeIds, userId, model, params, msg);
    if (canvasDocName) {
      for (const nodeId of nodeIds) {
        await emitNodeStateFailed(streamRedis, canvasDocName, nodeId, msg);
      }
    }
    return { failed: true, reason: "output_count_mismatch" };
  }

  // ─── Point of no return: record that the provider has returned ───
  // From here on, any failure must NOT re-run the provider. We write
  // provider_result_url (or a sentinel if the transport returned a
  // raw buffer with no upstream URL) so the re-entry guard at the top
  // of runTask can detect a duplicate delivery and fail-fast.
  const providerUrlSentinel =
    unified.outputs[0]?.url ??
    (providerResult.url_original as string | undefined) ??
    `buffer://${taskId}`; // sync transports return raw bytes with no URL
  await taskService.recordProviderResult(taskId, providerUrlSentinel);

  // ─── Stage 2: Persist to permanent storage ────────────────────────
  // Any error here marks the task failed with NO CHARGE and NO RETRY.
  let persistedOutputs: Array<{ url?: string; cover_url?: string; extra?: Record<string, unknown> }>;
  try {
    persistedOutputs = await persistOutputs(unified.outputs, unified.extras, { taskType, userId, projectId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, error: errorMsg }, "persist_failed_no_charge");
    await taskService.markFailed(taskId, `Persist failed: ${errorMsg}`);
    await recordFailureHistory(taskId, projectId, nodeIds, userId, model, params, errorMsg);
    if (canvasDocName) {
      for (const nodeId of nodeIds) {
        await emitNodeStateFailed(streamRedis, canvasDocName, nodeId, errorMsg);
      }
    }
    // Return normally (don't throw) — we don't want BullMQ to retry
    // something we've explicitly decided not to charge for.
    return { failed: true, reason: "persist_failed" };
  }

  // Extract video cover per output (best-effort, failure is non-fatal).
  // `extractVideoCover` is worker-private (it shells out to ffmpeg, a
  // worker-only concern) and returns `undefined` on failure; this
  // handler — the single call site — decides whether to warn.
  if (taskType === "video") {
    const { extractVideoCover } = await import("@worker/providers/video-cover.js");
    for (const out of persistedOutputs) {
      if (typeof out.url === "string" && !out.cover_url) {
        try {
          const coverUrl = await extractVideoCover(out.url, { userId, projectId });
          if (coverUrl) {
            out.cover_url = coverUrl;
          } else {
            logger.warn(
              { taskId, videoUrl: out.url },
              "video_cover_extraction_returned_empty_non_fatal",
            );
          }
        } catch (err) {
          logger.warn({ taskId, err }, "video_cover_extraction_failed_non_fatal");
        }
      }
    }
  }

  // Canonical result dict stored on the task row — mirrors the unified
  // outputs schema so downstream consumers (history, audits) see one shape.
  const result: Record<string, unknown> = {
    ...unified.extras,
    outputs: persistedOutputs,
  };

  const durationMs = Math.round(performance.now() - startTime);

  // ─── Stage 3: Mark completed + charge (atomic via CAS) ────────────
  // markCompletedAndBill uses a WHERE billed_at IS NULL clause so only
  // the first Worker to reach this step wins the charge. Any subsequent
  // retry (shouldn't happen given the re-entry guard above, but defense
  // in depth) reads `wasFirst = false` and skips the deduct step.
  await taskService.setResolvedSkills(taskId, resolvedSkills);
  const wasFirst = await taskService.markCompletedAndBill(taskId, result, creditsUsed, durationMs);

  if (wasFirst && creditsUsed > 0) {
    try {
      await creditService.deduct(
        userId,
        creditsUsed,
        `Task: ${taskType}`,
        taskId,
        { model: (result.model as string | undefined) ?? model },
      );
    } catch (err) {
      // Deduct failed AFTER the CAS marked billed_at. The file is
      // already persisted and the task is completed. Log loudly for
      // manual reconciliation — do NOT roll back billed_at because
      // that would allow a double-charge on the next retry. Also do
      // NOT fail the task — the user is entitled to their result.
      logger.error(
        { taskId, userId, creditsUsed, err },
        "DEDUCT_FAILED_AFTER_COMPLETION — manual reconciliation required",
      );
    }
  } else if (!wasFirst) {
    logger.info({ taskId }, "Task already completed by a prior run; skipping deduct");
  }

  // ─── Stage 4: Record history + publish NodeStateUpdateEvent ──────
  if (canvasDocName && projectId && nodeIds.length > 0) {
    // ★ B1 (spec §10.15.5): verify the canvas-node lock is still ours
    // before publishing the success event. The TTL might have expired and
    // someone else reclaimed the node — in that case, our result must NOT
    // overwrite their in-flight handling state. Mark this task failed and
    // skip publish; the lock holder will eventually publish their own result.
    if (lockTargetNodeId) {
      const stillOwn = await verifyCanvasNodeLock(
        projectId,
        lockTargetNodeId,
        taskId,
      );
      if (!stillOwn) {
        logger.warn(
          { taskId, nodeId: lockTargetNodeId, projectId },
          "canvas_lock_lost_discarding_result",
        );
        await taskService.markFailed(
          taskId,
          "Canvas-node lock no longer held; result discarded (spec §10.15.5)",
        );
        return { failed: true, reason: "lock_lost" };
      }
    }
    const docName = canvasDocName;
    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i]!;
      const out = persistedOutputs[i];
      const url = out?.url;
      if (typeof url !== "string") continue;
      try {
        await nodeHistoryService.recordGenerationSuccess({
          projectId,
          nodeId,
          userId,
          content: url,
          thumbnailUrl: out?.cover_url ?? (taskType === "image" ? url : undefined),
          taskId,
          metadata: {
            model: (unified.extras.model as string | undefined) ?? model,
            cost: unified.extras.cost as number | undefined,
            durationMs,
            params,
          },
        });
      } catch (err) {
        logger.warn({ err, taskId, nodeId }, "Failed to record node history (success)");
      }

      try {
        await emitNodeStateDone(streamRedis, docName, nodeId, {
          content: url,
          cover_url: out?.cover_url,
        });
      } catch (err) {
        logger.warn({ err, taskId, nodeId }, "Failed to publish NodeStateUpdateEvent (success)");
      }
    }
  }

  logger.info(
    { taskId, taskType, skillName, resolvedSkills, creditsUsed, durationMs, billed: wasFirst },
    "task_completed",
  );
  return result;
}

// ─── Event emit helpers ──────────────────────────────────────────────

/** Content fields that may appear in a success NodeStateUpdateEvent. */
export interface NodeStateDoneFields {
  /** Permanent URL of the generated asset. */
  content: string;
  /** Optional cover/thumbnail URL (video first-frame, 3D preview, etc.). */
  cover_url?: string;
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
 */
export async function emitNodeStateDone(
  streamRedis: ReturnType<typeof getStreamRedis>,
  docName: string,
  nodeId: string,
  contentFields: NodeStateDoneFields,
): Promise<void> {
  await publishNodeEvent(streamRedis, {
    type: "node-state-update",
    docName,
    nodeId,
    update: {
      state: "idle",
      content: contentFields.content,
      cover_url: contentFields.cover_url,
      width: contentFields.width,
      height: contentFields.height,
      duration: contentFields.duration,
      // null survives JSON.stringify (undefined is stripped).
      // The Collab consumer calls Y.Map.delete("handlingBy") on null.
      handlingBy: null,
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
 */
export async function emitNodeStateFailed(
  streamRedis: ReturnType<typeof getStreamRedis>,
  docName: string,
  nodeId: string,
  errorMessage: string,
): Promise<void> {
  await publishNodeEvent(streamRedis, {
    type: "node-state-update",
    docName,
    nodeId,
    update: {
      state: "idle",
      errorMessage,
      // null survives JSON.stringify (undefined is stripped).
      // The Collab consumer calls Y.Map.delete("handlingBy") on null.
      handlingBy: null,
    },
  });
}

// ─── Failure-path helpers ────────────────────────────────────────────

/**
 * Record failed-generation entries in node_history (non-fatal).
 * @param taskId - Task whose failure is being recorded
 * @param projectId - Project the failed nodes belong to; when undefined the call is a no-op
 * @param nodeIds - Canvas nodes that should receive a failure history entry
 * @param userId - User who owns the failed task
 * @param model - Model name used for the attempt, if any
 * @param params - Original task params, stored in the history metadata
 * @param errorMessage - Human-readable failure reason
 */
async function recordFailureHistory(
  taskId: string,
  projectId: string | undefined,
  nodeIds: string[],
  userId: string,
  model: string | undefined,
  params: Record<string, unknown>,
  errorMessage: string,
): Promise<void> {
  if (!projectId || nodeIds.length === 0) return;
  for (const nodeId of nodeIds) {
    try {
      await nodeHistoryService.recordGenerationFailure({
        projectId,
        nodeId,
        userId,
        errorMessage,
        taskId,
        metadata: { model, params },
      });
    } catch (err) {
      logger.warn({ err, taskId, nodeId }, "Failed to record node history (failure)");
    }
  }
}

// ── Normalisation + persistence helpers ────────────────────────────

/**
 * Collapse provider / handler raw results into a unified outputs
 * shape. Provider paths return `{url, cover_url, buffer?, cost, ...}`
 * (always one output). Local handlers return
 * `{outputs:[{url,cover_url?,extra?}], cost}` (N outputs). Callers
 * downstream consume a single shape.
 * @param raw - Raw provider or local-handler result dict
 * @returns The normalised `{ outputs, extras }` view where `outputs` is always an array
 */
function toUnifiedOutputs(raw: Record<string, unknown>): {
  outputs: Array<{ url?: string; cover_url?: string; extra?: Record<string, unknown> }>;
  extras: Record<string, unknown>;
} {
  if (Array.isArray(raw.outputs)) {
    const outputs = raw.outputs as Array<{ url?: string; cover_url?: string; extra?: Record<string, unknown> }>;
    const extras: Record<string, unknown> = { ...raw };
    delete extras.outputs;
    return { outputs, extras };
  }
  const { url, cover_url, buffer, contentType, ...rest } = raw;
  return {
    outputs: [{
      url: url as string | undefined,
      cover_url: cover_url as string | undefined,
      extra: (buffer !== undefined || contentType !== undefined)
        ? { buffer, contentType }
        : undefined,
    }],
    extras: rest,
  };
}

/**
 * Persist each output's URL / buffer to permanent storage. Mirrors the
 * pre-refactor `persistResultUrls` but iterates outputs.
 * @param outputs - Unified outputs, each possibly carrying a temp URL or raw buffer
 * @param extras - Non-output result fields that may also carry re-hostable URLs
 * @param opts - Persistence context
 * @param opts.taskType - Task type, used to pick the storage extension and key prefix
 * @param opts.userId - User who owns the persisted assets
 * @param opts.projectId - Project the assets belong to, if any
 * @returns The outputs with temp URLs / buffers replaced by permanent storage URLs
 */
async function persistOutputs(
  outputs: Array<{ url?: string; cover_url?: string; extra?: Record<string, unknown> }>,
  extras: Record<string, unknown>,
  opts: { taskType: string; userId: string; projectId?: string },
): Promise<Array<{ url?: string; cover_url?: string; extra?: Record<string, unknown> }>> {
  const extMap: Record<string, string> = {
    image: ".png",
    video: ".mp4",
    audio: ".mp3",
    tts: ".mp3",
    three_d: ".glb",
    understand: ".json",
  };
  const ext = extMap[opts.taskType] ?? ".bin";
  /**
   * Build a fresh storage key for one persisted asset.
   * @returns A unique storage key scoped to the user / project / task type
   */
  const makeKey = (): string => storageKey({
    userId: opts.userId,
    projectId: opts.projectId,
    taskType: opts.taskType,
    ext,
  });

  const persisted: Array<{ url?: string; cover_url?: string; extra?: Record<string, unknown> }> = [];

  for (const out of outputs) {
    const next: { url?: string; cover_url?: string; extra?: Record<string, unknown> } = { ...out };

    // Case 1: raw bytes from sync transports (sync provider calls).
    // These live in extra.buffer / extra.contentType (normalized by
    // toUnifiedOutputs) rather than a top-level field.
    const extra = next.extra ?? {};
    if (Buffer.isBuffer((extra).buffer)) {
      try {
        const key = makeKey();
        const contentType = ((extra).contentType as string) ?? "application/octet-stream";
        const adapter = await getStorageAdapter();
        const url = await adapter.upload(key, (extra).buffer, contentType);
        next.url = url;
        logger.info({ key, size: ((extra).buffer).length }, "Persisted sync transport result");
      } catch (err) {
        logger.warn({ err }, "Failed to persist buffer result");
      }
      delete (extra).buffer;
      delete (extra).contentType;
    }

    // Case 2: temporary CDN URL — re-host to our storage.
    if (typeof next.url === "string" && next.url.startsWith("http") && !next.url.includes("/uploads/")) {
      try {
        const key = makeKey();
        const permanentUrl = await downloadAndStore(next.url, key);
        if (!next.extra) next.extra = {};
        (next.extra).url_original = next.url;
        next.url = permanentUrl;
      } catch (err) {
        logger.warn({ url: next.url, err }, "Failed to persist result URL, keeping original");
      }
    }

    persisted.push(next);
  }

  // Provider-level extras (non-output fields) may also carry URL
  // fields used by consumers — re-host them the same way. Kept for
  // parity with the pre-refactor behaviour that persisted e.g.
  // `audio_url` / `image_url` on the result dict.
  const urlFields = ["result_url", "audio_url", "video_url", "image_url", "output_url"];
  for (const field of urlFields) {
    const value = extras[field];
    if (typeof value !== "string" || !value.startsWith("http")) continue;
    if (value.includes("/uploads/")) continue;
    try {
      const key = makeKey();
      const permanentUrl = await downloadAndStore(value, key);
      extras[field] = permanentUrl;
      extras[`${field}_original`] = value;
    } catch (err) {
      logger.warn({ field, url: value, err }, "Failed to persist result URL, keeping original");
    }
  }

  return persisted;
}

// ── Execution Path Helpers ───────────────────────────────────────────

interface RunMiniToolOpts {
  toolName: string;
  taskType: string;
  params: Record<string, unknown>;
  jobId: string;
  userId: string;
  projectId: string | undefined;
}

/**
 * Execution path 1: run a mini-tool, dispatching to a local ffmpeg/Sharp
 * handler or to an AIGC provider depending on the registry entry kind.
 * @param opts - Mini-tool invocation context (tool name, task type, params, ids)
 * @returns A `[result, credits]` tuple: the provider/handler result dict and the credits to charge
 */
async function runMiniTool(
  opts: RunMiniToolOpts,
): Promise<[Record<string, unknown>, number]> {
  const { toolName, taskType, params, jobId, userId, projectId } = opts;
  const entry = resolveMiniToolEntry(taskType, toolName);

  // Strip workflow-meta fields that are for infra (not for the
  // provider/handler to see). Model override survives so users can
  // pick a non-default vendor model; it's stripped again inside the
  // provider branch before validation.
  const cleanParams = { ...params };
  delete cleanParams.node_ids;
  delete cleanParams.project_id;

  if (entry.kind === "local") {
    const result = await runLocalHandler({
      handler: entry.handler,
      taskType,
      toolName,
      params: cleanParams,
      jobId,
      userId,
      projectId,
    });
    const cost = result.cost ?? 0;
    const credits = cost * 100 * env.CREDIT_MULTIPLIER;
    return [result as unknown as Record<string, unknown>, credits];
  }

  // kind === "provider"
  const modelName = (cleanParams.model as string) || entry.model;
  delete cleanParams.model;

  const provider = await importProvider(taskType);
  const [, validated] = provider.validateParams(modelName, cleanParams);

  const prompt = (validated.prompt ?? validated.text ?? "") as string;
  delete validated.prompt;
  delete validated.text;

  const result = await provider.generateAsync(prompt, modelName, validated);
  const cost = (result.cost as number) ?? 0;
  const credits = cost * 100 * env.CREDIT_MULTIPLIER;

  return [result, credits];
}

/**
 * Execution path 2: run media understanding (image / video / audio
 * analysis or ASR) via the understand provider.
 * @param model - Model override, or undefined to use the per-source-type default
 * @param params - Task params carrying `source_type`, `source_url` and an optional prompt
 * @returns A `[result, credits]` tuple: the analysis result dict and the credits to charge
 */
async function runUnderstand(
  model: string | undefined,
  params: Record<string, unknown>,
): Promise<[Record<string, unknown>, number]> {
  const sourceType = params.source_type as string;
  const sourceUrl = params.source_url as string;
  const modelName = model ?? UNDERSTAND_DEFAULTS[sourceType] ?? "gemini-flash-vi";
  const prompt = extractPromptText(params.prompt) || `Analyze this ${sourceType}`;

  const cleanParams: Record<string, unknown> = {};
  if (sourceType === "image") cleanParams.images = [sourceUrl];
  else if (sourceType === "video") cleanParams.video_url = sourceUrl;
  else if (sourceType === "audio") {
    cleanParams.audio_url = sourceUrl;
    cleanParams.audio = sourceUrl;
  }

  const { generateAsync } = await import("@worker/providers/understand/index.js");
  const result = await generateAsync(prompt, modelName, cleanParams);
  const cost = (result.cost) ?? 0;
  const credits = cost * 100 * env.CREDIT_MULTIPLIER;

  return [result, credits];
}

/**
 * Execution path 3: run an AIGC provider directly with explicit params
 * (no skill agent loop). Strips and sanitises the prompt before sending.
 * @param taskType - AIGC task type (image / audio / video / tts / three_d)
 * @param model - Model name to invoke; required for this path
 * @param params - Task params, including the raw prompt/text to sanitise
 * @returns A `[result, credits]` tuple: the provider result dict and the credits to charge
 * @throws {Error} when `model` is not provided
 */
async function runAigcDirect(
  taskType: string,
  model: string | undefined,
  params: Record<string, unknown>,
): Promise<[Record<string, unknown>, number]> {
  if (!model) throw new Error(`model is required for AIGC direct path (${taskType})`);

  // Extract prompt/text and strip HTML before sending to provider
  const prompt = extractPromptText(params.prompt ?? params.text);
  const cleanParams = { ...params };
  delete cleanParams.prompt;
  delete cleanParams.text;
  delete cleanParams.node_ids;
  delete cleanParams.project_id;

  const provider = await importProvider(taskType);
  const [, validated] = provider.validateParams(model, cleanParams);

  const result = await provider.generateAsync(prompt, model, validated);
  const cost = (result.cost as number) ?? 0;
  const credits = cost * 100 * env.CREDIT_MULTIPLIER;

  return [result, credits];
}

/**
 * Execution paths 4 & 5: run an AI SDK agent loop driven by a skill.
 * Path 4 uses an explicit skill; path 5 auto-selects and merges all skills
 * registered for the task-type category and lets the LLM choose tools.
 * @param taskType - Task type, used as the skill category for auto-select
 * @param skillName - Explicit skill to run (path 4), or undefined to auto-select (path 5)
 * @param params - Task params serialised into the user message for the agent
 * @returns A `[text, resolvedSkills]` tuple: the agent's final text and the skill names used
 * @throws {Error} when the explicit skill is missing, or no skills exist for the category
 */
async function runSkillAgent(
  taskType: string,
  skillName: string | undefined,
  params: Record<string, unknown>,
): Promise<[string, string[]]> {
  const registry = getSkillRegistry();
  let skillContent: string;
  let toolNames: string[];
  let resolved: string[];

  if (skillName) {
    // Path 4: Explicit skill
    const skill = registry.get(skillName);
    if (!skill) throw new Error(`Skill not found: ${skillName}`);
    skillContent = registry.loadSkillContent(skillName);
    toolNames = skill.tools;
    resolved = [skillName];
  } else {
    // Path 5: Auto-select by category
    const categorySkills = registry.listByCategory(taskType);
    if (categorySkills.length === 0) {
      throw new Error(`No skills found for category '${taskType}'`);
    }

    const allToolNames: string[] = [];
    const sections: string[] = [];
    for (const s of categorySkills) {
      allToolNames.push(...s.tools);
      sections.push(`## Skill: ${s.name}\n${registry.loadSkillContent(s.name)}`);
    }

    // Deduplicate tools
    toolNames = [...new Set(allToolNames)];
    skillContent = `You have multiple skills available for [${taskType}] tasks.\n\n` + sections.join("\n\n---\n\n");
    resolved = categorySkills.map((s) => s.name);
  }

  const tools = buildToolSet(toolNames);
  const result = await generateText({
    model: getModel(),
    system: skillContent,
    messages: [{ role: "user" as const, content: JSON.stringify(params) }],
    tools,
    stopWhen: stepCountIs(15),
  });

  return [result.text || "Task completed.", resolved];
}


/**
 * Dynamic provider import by task type.
 * @param taskType - Task type whose modality selects the provider module to load
 * @returns The provider's `validateParams` / `generateAsync` pair
 * @throws {Error} when the task type maps to an unknown AIGC modality
 */
async function importProvider(taskType: string): Promise<{
  validateParams: (model: string, params: Record<string, unknown>) => [string, Record<string, unknown>];
  generateAsync: (prompt: string, model: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const modality = AIGC_TASK_TYPES[taskType] ?? taskType;
  /**
   * Normalise a provider module's validate/generate exports into the
   * common `{ validateParams, generateAsync }` shape used by callers.
   * @param validate - Provider param validator (model may be undefined)
   * @param generate - Provider async generation function
   * @returns The wrapped provider interface with a non-optional model on `validateParams`
   */
  const wrap = (
    validate: (m: string | undefined, p?: Record<string, unknown>) => [string, Record<string, unknown>],
    generate: (prompt: string, model: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): {
    validateParams: (model: string, params: Record<string, unknown>) => [string, Record<string, unknown>];
    generateAsync: (prompt: string, model: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } => ({
    validateParams: (model: string, params: Record<string, unknown>) => validate(model, params),
    generateAsync: generate,
  });
  switch (modality) {
    case "image": { const m = await import("@worker/providers/image/index.js"); return wrap(m.validateImageParams, m.generateAsync); }
    case "video": { const m = await import("@worker/providers/video/index.js"); return wrap(m.validateVideoParams, m.generateAsync); }
    case "audio": { const m = await import("@worker/providers/audio/index.js"); return wrap(m.validateAudioParams, m.generateAsync); }
    case "tts": { const m = await import("@worker/providers/tts/index.js"); return wrap(m.validateTtsParams, m.generateAsync); }
    case "three-d": { const m = await import("@worker/providers/three-d/index.js"); return wrap(m.validateThreeDParams, m.generateAsync); }
    default: throw new Error(`Unknown AIGC task type: ${taskType}`);
  }
}
