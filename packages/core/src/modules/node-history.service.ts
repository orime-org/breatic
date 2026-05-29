/**
 * Node history service — business logic for per-node content timeline.
 *
 * Delegates persistence to the repo. Provides helpers used by the
 * Worker (on task completion/failure) and the upload endpoint.
 */

import * as repo from "@core/modules/node-history.repo.js";
import { NotFoundError } from "@core/errors.js";
import type { NodeHistoryEntity } from "@breatic/shared";

/**
 * Record a successful AIGC generation.
 *
 * Called by Worker after a task completes and its result has been
 * persisted to permanent storage.
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
 *
 * @param projectId - Project UUID
 * @param nodeId - Node ID (from Canvas)
 * @param opts - Pagination and optional status filter
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
 *
 * @throws AppError(404) if the entry does not exist
 */
export async function getById(id: string): Promise<NodeHistoryEntity> {
  const entry = await repo.getById(id);
  if (!entry) {
    throw new NotFoundError(`History entry not found: ${id}`);
  }
  return entry;
}
