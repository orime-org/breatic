// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Session-scoped stash of Files whose upload failed (#1609 P4, re-keyed in
 * #186 §3.7.2): a task row offers Retry as long as its File is still held
 * here.
 *
 * Keyed by task rather than by node, because a node carries several uploads
 * at once now. Keyed by node, two failures on one node left only the last
 * File, and either one succeeding cleared the other's.
 *
 * In-memory only by design — the browser cannot re-read a picked file after a
 * refresh (platform ceiling, plan §6), so a reload drops the stash and the
 * user re-picks the file.
 */

const retryFiles = new Map<string, File>();

/**
 * The composite stash key — task ids come from one table, and the project and
 * space keep this session's stash apart from another space's.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The failed task.
 * @returns The map key.
 */
function keyOf(projectId: string, spaceId: string, taskId: string): string {
  return `${projectId}/${spaceId}/${taskId}`;
}

/**
 * Hold a failed upload's File for a later retry.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The failed task.
 * @param file - The original picked/dropped File.
 */
export function stashRetryFile(
  projectId: string,
  spaceId: string,
  taskId: string,
  file: File,
): void {
  retryFiles.set(keyOf(projectId, spaceId, taskId), file);
}

/**
 * The stashed File for a failed task, if this session still holds one.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The failed task.
 * @returns The File, or undefined (no stash → no Retry button).
 */
export function getRetryFile(
  projectId: string,
  spaceId: string,
  taskId: string,
): File | undefined {
  return retryFiles.get(keyOf(projectId, spaceId, taskId));
}

/**
 * Whether a failed task still has a retryable File in this session.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The failed task.
 * @returns True when a Retry button should render on that row.
 */
export function hasRetryFile(
  projectId: string,
  spaceId: string,
  taskId: string,
): boolean {
  return retryFiles.has(keyOf(projectId, spaceId, taskId));
}

/**
 * Drop one task's stash (after its retry succeeded, or the user cleared the
 * row it was offered on).
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The task whose stash to drop.
 */
export function clearRetryFile(
  projectId: string,
  spaceId: string,
  taskId: string,
): void {
  retryFiles.delete(keyOf(projectId, spaceId, taskId));
}

/**
 * Empty the stash (tests only).
 */
export function resetRetryFilesForTests(): void {
  retryFiles.clear();
}
