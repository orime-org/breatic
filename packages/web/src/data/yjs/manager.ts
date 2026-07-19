// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as Y from 'yjs';
import { projectMetaDocName, canvasSpaceDocName } from '@breatic/shared';

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
 * Listeners fired right after a doc is destroyed + evicted (#1786). Sibling
 * caches keyed by the same doc name (e.g. the per-space undo managers in
 * `canvas-space.ts`) subscribe so they can drop their own reference — otherwise
 * they keep pinning the destroyed doc's content and the leak this cache eviction
 * kills is merely relocated. Kept as an event so `manager.ts` stays the lowest
 * layer (it must not import the caches that depend on it).
 */
const docDestroyListeners = new Set<(name: string) => void>();

/**
 * Subscribe to doc-destroyed events (fired by {@link destroyDoc}). The listener
 * receives the destroyed doc's name so it can evict any sibling cache entry
 * keyed by that name. Registered once at module load by the owning cache.
 * @param listener - Called with the doc name after each destroy + eviction.
 */
export function onDocDestroyed(listener: (name: string) => void): void {
  docDestroyListeners.add(listener);
}

/**
 * Get-or-create a `Y.Doc` for the given document name. Subsequent calls
 * with the same name return the same instance.
 * @param name - Canonical document name (e.g. `project-{id}/meta`).
 * @returns The cached or newly created Y.Doc for that name.
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
 * @param name - Canonical document name to destroy and evict from the cache.
 */
export function destroyDoc(name: string): void {
  const doc = docs.get(name);
  if (!doc) return;
  doc.destroy();
  docs.delete(name);
  // Let sibling caches keyed by this name drop their reference too (#1786) —
  // e.g. the per-space undo manager, which otherwise keeps the destroyed doc's
  // content pinned in memory (relocating, not fixing, the leak).
  docDestroyListeners.forEach((listener) => listener(name));
}

/**
 * Doc name helpers — delegate to the single source of truth in
 * `@breatic/shared` (the Yjs doc-name format is a frontend↔backend
 * protocol; the backend routes docs by the same builders). Kept as a
 * thin `docName.*` facade so existing web call sites don't change.
 * 2026-05-29: de-duplicated the previously hardcoded local copies.
 */
export const docName = {
  projectMeta: projectMetaDocName,
  canvasSpace: canvasSpaceDocName,
};

/**
 * Reset the doc cache (test helper — not for production use). Does NOT clear the
 * destroy listeners: those are registered once at module load by sibling caches
 * (e.g. canvas-space's undo evictor) and must survive a reset, or subsequent
 * destroys would silently stop evicting them.
 */
export function _resetForTests(): void {
  docs.forEach((d) => d.destroy());
  docs.clear();
}
