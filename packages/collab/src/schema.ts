/**
 * Yjs document name conventions for the canvas Collab service.
 *
 * The canonical data shapes for canvas node data and the Redis
 * event bus live in `@breatic/shared`. This module only owns the
 * document naming helpers that are specific to the Collab service.
 */

/**
 * Canvas document name convention.
 *
 * @param projectId - Project UUID
 * @returns Document name for the canvas (e.g. `"project-abc123/canvas"`)
 */
export function canvasDocName(projectId: string): string {
  return `project-${projectId}/canvas`;
}

/**
 * Node editor document name convention.
 *
 * @param projectId - Project UUID
 * @param nodeId - Node ID
 * @returns Document name for a node's editor (e.g. `"project-abc123/node/xyz"`)
 */
export function nodeEditorDocName(projectId: string, nodeId: string): string {
  return `project-${projectId}/node/${nodeId}`;
}
