/**
 * Yjs document naming conventions, shared across Collab / Worker / Web.
 *
 * `docName` is the canonical identifier for a Hocuspocus document —
 * the same string appears on the WebSocket handshake, in PostgreSQL
 * persistence rows, and in `NodeEvent.docName` on the task-events
 * Redis stream. Keep the encoding in one place so nobody drifts.
 *
 * Shapes:
 *   - `project-{projectId}/canvas`              → main canvas
 *   - `project-{projectId}/node/{hostNodeId}`   → per-node launch-editor
 *     sub-canvas (used by mixed-editor image/video/audio and by text
 *     editor). The two share the name pattern but differ in Y-doc
 *     internal structure — the consumer distinguishes by inspecting
 *     the loaded doc, not by the name alone.
 */

/**
 * Build the Yjs document name for a project's main canvas.
 *
 * @param projectId - Project UUID
 * @returns Document name, e.g. `"project-abc123/canvas"`
 */
export function canvasDocName(projectId: string): string {
  return `project-${projectId}/canvas`;
}

/**
 * Build the Yjs document name for a node's launch-editor sub-canvas.
 *
 * @param projectId - Project UUID
 * @param nodeId - Main-canvas node ID that hosts the editor
 * @returns Document name, e.g. `"project-abc123/node/xyz"`
 */
export function nodeEditorDocName(projectId: string, nodeId: string): string {
  return `project-${projectId}/node/${nodeId}`;
}

/**
 * Parsed components of a Yjs document name.
 *
 * Used by the Collab task-listener to route an incoming `NodeEvent`
 * to the correct Yjs document traversal (`canvas.nodesMap` vs
 * mixed-editor `flow`).
 */
export type ParsedDocName =
  | { kind: "canvas"; projectId: string }
  | { kind: "nodeEditor"; projectId: string; nodeId: string };

/**
 * Parse a Yjs document name back into its components.
 *
 * Returns `null` for unknown patterns — consumers stay
 * forward-compatible with future naming schemes by silently skipping
 * what they don't recognise.
 *
 * @param docName - e.g. `"project-abc/canvas"` or `"project-abc/node/xyz"`
 */
export function parseDocName(docName: string): ParsedDocName | null {
  const canvasMatch = docName.match(/^project-([^/]+)\/canvas$/);
  if (canvasMatch) {
    return { kind: "canvas", projectId: canvasMatch[1]! };
  }
  const nodeMatch = docName.match(/^project-([^/]+)\/node\/(.+)$/);
  if (nodeMatch) {
    return { kind: "nodeEditor", projectId: nodeMatch[1]!, nodeId: nodeMatch[2]! };
  }
  return null;
}
