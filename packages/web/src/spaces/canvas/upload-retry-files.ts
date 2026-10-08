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
 * A browser mini-tool's export keeps its tag with the File, so a retry comes
 * back as that tool rather than as a plain upload (inner#888 §7.5).
 *
 * In-memory only by design — the browser cannot re-read a picked file after a
 * refresh (platform ceiling, plan §6), so a reload drops the stash and the
 * user re-picks the file.
 */

import type { MiniToolUploadTag } from '@web/data/upload/ingest-upload';

/** What a retry re-sends. */
export interface RetryUpload {
  file: File;
  /** Present when a browser mini-tool made the file. */
  context?: MiniToolUploadTag;
}

const retryFiles = new Map<string, RetryUpload>();

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
 * @param context - The mini-tool tag the upload carried, if any.
 */
export function stashRetryFile(
  projectId: string,
  spaceId: string,
  taskId: string,
  file: File,
  context?: MiniToolUploadTag,
): void {
  retryFiles.set(
    keyOf(projectId, spaceId, taskId),
    context === undefined ? { file } : { file, context },
  );
}

/**
 * What a failed task's retry re-sends, if this session still holds it.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The failed task.
 * @returns The File and its tag, or undefined (no stash → no Retry button).
 */
export function getRetryUpload(
  projectId: string,
  spaceId: string,
  taskId: string,
): RetryUpload | undefined {
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
 * Drop one task's stash, once the reader clears the row it was offered on.
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
