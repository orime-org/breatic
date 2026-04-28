/**
 * Yjs document naming convention, shared across Collab / Worker / Web.
 *
 * Each project has exactly one Yjs document. The doc name is the
 * canonical identifier — appears on the WebSocket handshake, in
 * PostgreSQL persistence rows, and in `HistoryUpdateEvent.docName`
 * on the task-events Redis stream. Keep the encoding here so nobody
 * drifts.
 *
 * Shape: `project-{projectId}`
 */

/**
 * Build the Yjs document name for a project.
 *
 * @param projectId - Project UUID
 * @returns Document name, e.g. `"project-abc123"`
 */
export function projectDocName(projectId: string): string {
  return `project-${projectId}`;
}

/**
 * Extract the project ID from a doc name.
 *
 * Legacy `/canvas` and `/node/{id}` sub-paths are NOT recognized — those
 * are obsolete; this function returns null for them.
 *
 * @param docName - Document name string from WebSocket handshake or persistence layer
 * @returns Project ID extracted from the doc name, or null if malformed
 */
export function parseProjectDocName(docName: string): string | null {
  const match = docName.match(/^project-([^/]+)$/);
  return match ? (match[1] ?? null) : null;
}
