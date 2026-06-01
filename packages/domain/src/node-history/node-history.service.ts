/**
 * Node history service — business logic for per-node content timeline.
 *
 * Delegates persistence to the repo. Provides helpers used by the
 * Worker (on task completion/failure) and the upload endpoint.
 */

import * as repo from "@domain/node-history/node-history.repo.js";
import { NotFoundError } from "@breatic/core";
import type { NodeHistoryEntity } from "@breatic/shared";

/**
 * Record a successful AIGC generation.
 *
 * Called by Worker after a task completes and its result has been
 * persisted to permanent storage.
 * @param opts - Fields describing the successful generation.
 * @param opts.projectId - ID of the project owning the node.
 * @param opts.nodeId - ID of the canvas node the generation targets.
 * @param opts.userId - ID of the user who triggered the generation.
 * @param opts.content - Reference to the generated content (e.g. asset URL).
 * @param opts.thumbnailUrl - Thumbnail URL for previews, if available.
 * @param opts.taskId - ID of the task that produced this result.
 * @param opts.metadata - Generation metadata.
 * @param opts.metadata.model - Model identifier that produced the result.
 * @param opts.metadata.cost - Credits/cost attributed to the generation.
 * @param opts.metadata.durationMs - Provider call duration in milliseconds.
 * @param opts.metadata.params - Provider/tool parameters used for the generation.
 * @returns The created {@link NodeHistoryEntity}.
 */
export async function recordGenerationSuccess(opts: {
  projectId: string;
  nodeId: string;
  userId: string;
  content: string;
  thumbnailUrl?: string;
  taskId: string;
  metadata: {
    model?: string;
    cost?: number;
    durationMs?: number;
    params?: Record<string, unknown>;
  };
}): Promise<NodeHistoryEntity> {
  return repo.create({
    projectId: opts.projectId,
    nodeId: opts.nodeId,
    userId: opts.userId,
    entryType: "generation",
    status: "success",
    content: opts.content,
    thumbnailUrl: opts.thumbnailUrl,
    taskId: opts.taskId,
    metadata: opts.metadata,
  });
}

/**
 * Record a failed AIGC generation.
 *
 * Called by Worker when a task fails. The error message is surfaced
 * to the frontend for debugging and user feedback.
 * @param opts - Fields describing the failed generation.
 * @param opts.projectId - ID of the project owning the node.
 * @param opts.nodeId - ID of the canvas node the generation targeted.
 * @param opts.userId - ID of the user who triggered the generation.
 * @param opts.errorMessage - Human-readable failure reason surfaced to the frontend.
 * @param opts.taskId - ID of the task that failed.
 * @param opts.metadata - Optional generation metadata.
 * @param opts.metadata.model - Model identifier that was attempted.
 * @param opts.metadata.params - Provider/tool parameters used for the attempt.
 * @returns The created {@link NodeHistoryEntity}.
 */
export async function recordGenerationFailure(opts: {
  projectId: string;
  nodeId: string;
  userId: string;
  errorMessage: string;
  taskId: string;
  metadata?: {
    model?: string;
    params?: Record<string, unknown>;
  };
}): Promise<NodeHistoryEntity> {
  return repo.create({
    projectId: opts.projectId,
    nodeId: opts.nodeId,
    userId: opts.userId,
    entryType: "generation",
    status: "failed",
    errorMessage: opts.errorMessage,
    taskId: opts.taskId,
    metadata: opts.metadata ?? {},
  });
}

/**
 * Record a manual user upload that replaces node content.
 *
 * Called by the upload endpoint after the file is persisted to storage.
 * @param opts - Fields describing the uploaded content.
 * @param opts.projectId - ID of the project owning the node.
 * @param opts.nodeId - ID of the canvas node the upload replaces content on.
 * @param opts.userId - ID of the user who uploaded the file.
 * @param opts.content - Reference to the uploaded content (e.g. asset URL).
 * @param opts.thumbnailUrl - Thumbnail URL for previews, if available.
 * @param opts.metadata - Optional upload metadata.
 * @param opts.metadata.filename - Original filename of the upload.
 * @param opts.metadata.size - Size of the uploaded file in bytes.
 * @param opts.metadata.mimeType - MIME type of the uploaded file.
 * @returns The created {@link NodeHistoryEntity}.
 */
export async function recordUpload(opts: {
  projectId: string;
  nodeId: string;
  userId: string;
  content: string;
  thumbnailUrl?: string;
  metadata?: {
    filename?: string;
    size?: number;
    mimeType?: string;
  };
}): Promise<NodeHistoryEntity> {
  return repo.create({
    projectId: opts.projectId,
    nodeId: opts.nodeId,
    userId: opts.userId,
    entryType: "upload",
    status: "success",
    content: opts.content,
    thumbnailUrl: opts.thumbnailUrl,
    metadata: opts.metadata ?? {},
  });
}

/**
 * List history entries for a node, paginated, most recent first.
 * @param projectId - Project UUID
 * @param nodeId - Node ID (from Canvas)
 * @param opts - Pagination and optional status filter
 * @param opts.limit - Maximum rows to return; capped at 100. Defaults to 20.
 * @param opts.offset - Number of rows to skip for pagination. Defaults to 0.
 * @param opts.status - Optional filter to only `"success"` or `"failed"` entries.
 * @returns The page of entries plus the total count matching the filter.
 */
export async function listByNode(
  projectId: string,
  nodeId: string,
  opts: { limit?: number; offset?: number; status?: "success" | "failed" } = {},
): Promise<{ entries: NodeHistoryEntity[]; total: number }> {
  return repo.listByNode(projectId, nodeId, opts);
}

/**
 * Get a single history entry by ID.
 * @param id - UUID of the history entry to fetch.
 * @returns The {@link NodeHistoryEntity}.
 * @throws {NotFoundError} if the entry does not exist.
 */
export async function getById(id: string): Promise<NodeHistoryEntity> {
  const entry = await repo.getById(id);
  if (!entry) {
    throw new NotFoundError(`History entry not found: ${id}`);
  }
  return entry;
}
