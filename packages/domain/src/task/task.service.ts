/**
 * Task service — business logic for task lifecycle management.
 *
 * Enforces ownership checks and delegates state transitions
 * to the task repository.
 */

import * as taskRepo from "@domain/task/task.repo.js";
import { t } from "@breatic/shared";
import { NotFoundError, ForbiddenError } from "@breatic/core";
import type { TaskEntity } from "@breatic/shared";

/**
 * Create a new task record.
 * @param userId - Owner user UUID
 * @param projectId - Optional project UUID
 * @param spaceId - Space within the project (required; the Worker writes
 *   results back to `project-{projectId}/canvas-{spaceId}` — v10 multi-doc)
 * @param taskType - Task type identifier (e.g. "image", "audio")
 * @param mode - Required execution mode (spec §10.13 / §10.15):
 *   `'append'` (new sibling node) or `'overwrite'` (replace target's data;
 *   caller must hold the canvas-node Redis lock first).
 * @param params - Task parameters
 * @param model - Optional model name
 * @param skillName - Optional skill to execute
 * @param source - Task source (default "canvas")
 * @returns The newly created task entity
 */
export async function create(
  userId: string,
  projectId: string | undefined,
  spaceId: string,
  taskType: string,
  mode: "append" | "overwrite",
  params: Record<string, unknown>,
  model?: string,
  skillName?: string,
  source?: string,
): Promise<TaskEntity> {
  return taskRepo.createTask({
    userId,
    projectId,
    spaceId,
    taskType,
    mode,
    params,
    model,
    skillName,
    source,
  });
}

/**
 * Get a task by ID with ownership enforcement.
 * @param taskId - Task UUID
 * @param userId - Requesting user UUID
 * @returns The task entity
 * @throws {NotFoundError} if task does not exist
 * @throws {ForbiddenError} if userId does not match the task owner
 */
export async function get(taskId: string, userId: string): Promise<TaskEntity> {
  const task = await taskRepo.getTaskById(taskId);
  if (!task) throw new NotFoundError(t("server.error.not_found"));
  if (task.userId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  return task;
}

/**
 * List tasks for a user, ordered by most recent.
 * @param userId - Owner user UUID
 * @param limit - Maximum number of results
 * @param offset - Pagination offset
 * @returns Array of task entities
 */
export async function list(
  userId: string,
  limit?: number,
  offset?: number,
): Promise<TaskEntity[]> {
  return taskRepo.listTasksByUser(userId, limit, offset);
}

/**
 * Set the background job ID on a task.
 * @param taskId - Task UUID
 * @param jobId - ARQ/BullMQ job ID
 */
export async function setJobId(taskId: string, jobId: string): Promise<void> {
  await taskRepo.setJobId(taskId, jobId);
}

/**
 * Soft-delete a task. Used by routes that create a task optimistically
 * and then hit a conflict (e.g. node lock already held) — the task row
 * exists in DB but must not appear in listings or get picked up by
 * workers. Soft-delete sets `deletedAt`; list queries already filter
 * `deletedAt IS NULL`.
 * @param taskId - Task UUID
 */
export async function softDelete(taskId: string): Promise<void> {
  await taskRepo.softDeleteTask(taskId);
}

/**
 * Mark a task as running and record the job ID.
 * @param taskId - Task UUID
 * @param jobId - ARQ/BullMQ job ID
 */
export async function markRunning(taskId: string, jobId: string): Promise<void> {
  await taskRepo.setJobId(taskId, jobId);
  await taskRepo.updateTaskStatus(taskId, "running");
}

/**
 * Mark a task as completed with its result.
 * @param taskId - Task UUID
 * @param result - Task output data
 * @param creditsUsed - Optional credits consumed
 * @param durationMs - AIGC model call duration in milliseconds
 */
export async function markCompleted(
  taskId: string,
  result: Record<string, unknown>,
  creditsUsed?: number,
  durationMs?: number,
): Promise<void> {
  await taskRepo.updateTaskStatus(taskId, "completed", { result, creditsUsed, durationMs });
}

/**
 * Mark a task as failed with an error message.
 * @param taskId - Task UUID
 * @param error - Error description
 */
export async function markFailed(taskId: string, error: string): Promise<void> {
  await taskRepo.updateTaskStatus(taskId, "failed", { error });
}

/**
 * Backfill the resolved skills list after execution.
 * @param taskId - Task UUID
 * @param skills - Array of skill names used
 */
export async function setResolvedSkills(taskId: string, skills: string[]): Promise<void> {
  await taskRepo.setResolvedSkills(taskId, skills);
}

/**
 * Load a task by ID without ownership checks. Used by the Worker to
 * check re-entry state (provider_result_url) before executing.
 * @param taskId - UUID of the task to load.
 * @returns The {@link TaskEntity}, or null if not found or soft-deleted.
 */
export async function getByIdInternal(taskId: string): Promise<TaskEntity | null> {
  return taskRepo.getTaskById(taskId);
}

/**
 * Record that the AIGC provider has returned a result for this task.
 * Past this point, the Worker must NOT invoke the provider again even
 * if BullMQ redelivers the job (business policy: one successful provider
 * call per task).
 * @param taskId - UUID of the task to update.
 * @param providerResultUrl - URL the provider returned for this task's result.
 */
export async function recordProviderResult(
  taskId: string,
  providerResultUrl: string,
): Promise<void> {
  await taskRepo.recordProviderResult(taskId, providerResultUrl);
}

/**
 * Atomic "mark completed AND reserve billing" transition.
 *
 * Returns `true` if this call performed the transition (i.e. we should
 * actually deduct credits now). Returns `false` if another Worker has
 * already completed + billed this task, in which case the caller must
 * skip the deduct step entirely.
 * @param taskId - UUID of the task to mark completed.
 * @param result - Provider/tool result payload to persist on the task.
 * @param creditsUsed - Credits consumed; recorded as the billing guard amount.
 * @param durationMs - Wall-clock duration of the task in milliseconds.
 * @returns `true` if this call won the transition (caller should deduct now), `false` if already completed + billed.
 */
export async function markCompletedAndBill(
  taskId: string,
  result: Record<string, unknown>,
  creditsUsed: number,
  durationMs: number,
): Promise<boolean> {
  return taskRepo.markCompletedAndBill(taskId, result, creditsUsed, durationMs);
}
