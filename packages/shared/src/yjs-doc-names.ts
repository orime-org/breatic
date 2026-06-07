// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Yjs document naming convention, shared across Collab / Worker / Web.
 *
 * v10 multi-doc layout (spec §5.3):
 *
 *   project-{projectId}/meta              project metadata + spaces list
 *                                         + per-user tab state + Project
 *                                         awareness + stateless signal
 *                                         channel
 *   project-{projectId}/canvas-{spaceId}  Canvas Space content (nodesMap +
 *                                         edges)
 *   project-{projectId}/document-{spaceId}  Document Space (Tiptap; future)
 *   project-{projectId}/timeline-{spaceId}  Timeline Space (future)
 *
 * The doc name is the canonical identifier — appears on the Hocuspocus
 * WebSocket handshake, on the `yjs_documents.name` row in PostgreSQL,
 * and on the `docName` field of NodeStateUpdateEvent on the task-events
 * Redis stream. Keep encoding here so nobody drifts.
 */

/** Recognized doc kinds in the project's Yjs space. */
export type DocKind = "meta" | "canvas" | "document" | "timeline";

/**
 * Result of parsing a project-scoped doc name.
 *
 * `meta` doc has no `spaceId` (one per project); space-kind docs carry
 * a non-empty `spaceId` discriminating which space inside the project.
 */
export type ParsedDocName =
  | { projectId: string; kind: "meta"; spaceId?: undefined }
  | { projectId: string; kind: "canvas" | "document" | "timeline"; spaceId: string };

/**
 * Build the meta doc name for a project.
 * @param projectId - Project UUID
 * @returns `"project-{projectId}/meta"`
 */
export function projectMetaDocName(projectId: string): string {
  return `project-${projectId}/meta`;
}

/**
 * Build the Canvas Space doc name.
 * @param projectId - Project UUID
 * @param spaceId - Space UUID (a Canvas-kind space inside the project)
 * @returns `"project-{projectId}/canvas-{spaceId}"`
 */
export function canvasSpaceDocName(projectId: string, spaceId: string): string {
  return `project-${projectId}/canvas-${spaceId}`;
}

/**
 * Build the Document Space doc name (future kind).
 * @param projectId - Project UUID
 * @param spaceId - Space UUID
 * @returns `"project-{projectId}/document-{spaceId}"`
 */
export function documentSpaceDocName(projectId: string, spaceId: string): string {
  return `project-${projectId}/document-${spaceId}`;
}

/**
 * Build the Timeline Space doc name (future kind).
 * @param projectId - Project UUID
 * @param spaceId - Space UUID
 * @returns `"project-{projectId}/timeline-{spaceId}"`
 */
export function timelineSpaceDocName(projectId: string, spaceId: string): string {
  return `project-${projectId}/timeline-${spaceId}`;
}

/**
 * Build a Space's CONTENT doc name from its type — the single home for
 * "space type → content doc name".
 *
 * `lazySeedMeta` (the first Space) and the `space:create` RPC (every
 * later Space) seed each Space's content doc through this, so a Space's
 * content document name is always derived from its type, never hardcoded
 * to canvas. Adding a future kind is a one-line switch arm here (the
 * per-kind builders already exist above). The `kind` excludes `meta`
 * because the meta doc is project-scoped, not space-scoped.
 * @param projectId - Project UUID
 * @param spaceId - Space UUID
 * @param kind - The Space's type (canvas / document / timeline)
 * @returns `"project-{projectId}/{kind}-{spaceId}"`
 */
export function spaceContentDocName(
  projectId: string,
  spaceId: string,
  kind: Exclude<DocKind, "meta">,
): string {
  switch (kind) {
    case "canvas":
      return canvasSpaceDocName(projectId, spaceId);
    case "document":
      return documentSpaceDocName(projectId, spaceId);
    case "timeline":
      return timelineSpaceDocName(projectId, spaceId);
  }
}

/**
 * Parse a doc name into its constituent ids and kind.
 *
 * Recognizes only the four shapes built by the helpers above. Returns
 * `null` for everything else, including:
 *
 *   - the obsolete single-doc form `project-{pid}` (replaced by
 *     `meta` + per-space docs in v10)
 *   - legacy `project-{pid}/canvas` or `project-{pid}/node/{nodeId}`
 *     sub-paths (pre-v10 history)
 *   - bare kind without space id (e.g. `project-{pid}/canvas`)
 *   - unknown kinds
 *
 * The parser intentionally does NOT validate UUID format on the ids —
 * that is the caller's job at the persistence/auth boundary, where it
 * can return a structured error rather than a parse miss.
 * @param docName - Document name string from WebSocket handshake or
 *   persistence layer
 * @returns Parsed structure, or `null` if the name is not recognized
 */
export function parseDocName(docName: string): ParsedDocName | null {
  // Anchor on the project- prefix and require exactly one path segment.
  const match = docName.match(
    /^project-([^/]+)\/(meta|canvas|document|timeline)(?:-([^/]+))?$/,
  );
  if (!match) return null;

  const projectId = match[1];
  const kind = match[2] as DocKind;
  const spaceId = match[3];

  if (!projectId) return null;

  if (kind === "meta") {
    // meta doc must NOT have a `-{spaceId}` suffix.
    if (spaceId !== undefined) return null;
    return { projectId, kind: "meta" };
  }

  // Space-kind docs MUST have a non-empty spaceId.
  if (!spaceId) return null;
  return { projectId, kind, spaceId };
}

/**
 * Whether a doc name is any valid project-scoped doc.
 *
 * Convenience for hocuspocus auth gates and stream consumers that just
 * need a yes/no without caring about kind/ids.
 * @param docName - the Yjs document name to test
 * @returns `true` when `docName` parses as a project-scoped doc
 */
export function isProjectScopedDocName(docName: string): boolean {
  return parseDocName(docName) !== null;
}
