// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Session-scoped stash of Files whose upload failed (#1609, P4): the
 * failed node renders a Retry button as long as its File reference is
 * still held here. In-memory only by design — the browser cannot re-read
 * a picked file after a refresh (platform ceiling, plan §6), so a reload
 * simply drops the stash and the user re-picks the file.
 */

const retryFiles = new Map<string, File>();

/**
 * The composite stash key — node ids are only unique per space doc.
 * @param projectId - Owning project.
 * @param spaceId - Space the node lives in.
 * @param nodeId - The failed node.
 * @returns The map key.
 */
function keyOf(projectId: string, spaceId: string, nodeId: string): string {
  return `${projectId}/${spaceId}/${nodeId}`;
}

/**
 * Hold a failed upload's File for a later retry.
 * @param projectId - Owning project.
 * @param spaceId - Space the node lives in.
 * @param nodeId - The failed node.
 * @param file - The original picked/dropped File.
 */
export function stashRetryFile(
  projectId: string,
  spaceId: string,
  nodeId: string,
  file: File,
): void {
  retryFiles.set(keyOf(projectId, spaceId, nodeId), file);
}

/**
 * The stashed File for a failed node, if this session still holds one.
 * @param projectId - Owning project.
 * @param spaceId - Space the node lives in.
 * @param nodeId - The failed node.
 * @returns The File, or undefined (no stash → no Retry button).
 */
export function getRetryFile(
  projectId: string,
  spaceId: string,
  nodeId: string,
): File | undefined {
  return retryFiles.get(keyOf(projectId, spaceId, nodeId));
}

/**
 * Whether a failed node still has a retryable File in this session.
 * @param projectId - Owning project.
 * @param spaceId - Space the node lives in.
 * @param nodeId - The failed node.
 * @returns True when a Retry button should render.
 */
export function hasRetryFile(
  projectId: string,
  spaceId: string,
  nodeId: string,
): boolean {
  return retryFiles.has(keyOf(projectId, spaceId, nodeId));
}

/**
 * Drop a node's stash (after a successful upload or node deletion).
 * @param projectId - Owning project.
 * @param spaceId - Space the node lives in.
 * @param nodeId - The node whose stash to drop.
 */
export function clearRetryFile(
  projectId: string,
  spaceId: string,
  nodeId: string,
): void {
  retryFiles.delete(keyOf(projectId, spaceId, nodeId));
}

/**
 * Empty the stash (tests only).
 */
export function resetRetryFilesForTests(): void {
  retryFiles.clear();
}
