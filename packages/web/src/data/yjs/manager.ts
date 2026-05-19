import * as Y from 'yjs';

/**
 * Process-wide cache of Y.Doc instances keyed by document name.
 *
 * Document naming convention (v10 multi-doc):
 *   - `project-{projectId}/meta`         — project metadata + spaces list
 *   - `project-{projectId}/canvas-{spaceId}` — one doc per canvas space
 *
 * Yjs requires the SAME Y.Doc instance for a given name across all
 * consumers in a tab — otherwise edits go to parallel docs and never
 * sync. This cache enforces that invariant.
 */
const docs = new Map<string, Y.Doc>();

/**
 * Get-or-create a `Y.Doc` for the given document name. Subsequent calls
 * with the same name return the same instance.
 */
export function getDoc(name: string): Y.Doc {
  let doc = docs.get(name);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(name, doc);
  }
  return doc;
}

/**
 * Destroy and remove a document from the cache. Called when the user
 * navigates away from a project / space so memory can be reclaimed.
 *
 * Safe to call with an unknown name — no-op.
 */
export function destroyDoc(name: string): void {
  const doc = docs.get(name);
  if (!doc) return;
  doc.destroy();
  docs.delete(name);
}

/**
 * Doc name helpers — keep the naming convention in one place so any
 * rename only touches this file.
 */
export const docName = {
  projectMeta: (projectId: string) => `project-${projectId}/meta`,
  canvasSpace: (projectId: string, spaceId: string) =>
    `project-${projectId}/canvas-${spaceId}`,
};

/** Reset the entire cache (test helper — not for production use). */
export function _resetForTests(): void {
  docs.forEach((d) => d.destroy());
  docs.clear();
}
