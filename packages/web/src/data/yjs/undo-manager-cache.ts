// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A process-wide cache of Yjs undo managers, keyed by document name.
 *
 * An undo stack lives only in its manager's memory — it is never persisted in
 * the Y.Doc. So a manager owned by a React component dies with that component,
 * and switching Space tabs remounts the body (`SpaceOutlet` is keyed on the
 * Space id): the text survives, the history silently does not. Binding the
 * manager to the DOCUMENT instead — same lifetime as the cached `Y.Doc` — is
 * what makes a tab switch harmless.
 *
 * Every Space type that offers undo needs exactly this, differing only in how
 * its manager is constructed, so the caching lives here and each caller passes
 * its own factory.
 */

import type * as Y from 'yjs';

import { onDocDestroyed } from '@web/data/yjs/manager';

/** A per-document undo-manager cache. */
export interface UndoManagerCache {
  /**
   * Get-or-create the manager for a document. The first call creates one bound
   * to that doc; later calls return the same instance, so its stack survives a
   * tab switch. Pass the SAME doc `getDoc(name)` returns.
   */
  get: (doc: Y.Doc, name: string) => Y.UndoManager;
  /**
   * Destroy and drop the manager for a document, clearing its history. Called
   * when a tab closes, so reopening the Space starts clean. No-op for an
   * unknown name.
   */
  evict: (name: string) => void;
  /** Test helper — whether a manager is currently cached for a name. */
  has: (name: string) => boolean;
  /** Test helper — destroy and drop every cached manager. */
  reset: () => void;
}

/**
 * Build an undo-manager cache around a construction function.
 *
 * The returned cache evicts itself whenever a document is destroyed: the doc
 * lives in the manager registry and dies when its last provider releases, and
 * a manager left behind would keep that dead doc's content pinned — relocating
 * the leak the doc eviction exists to fix, rather than fixing it.
 * @param create - Builds a manager for a document; called on a cache miss.
 * @returns The cache.
 */
export function createUndoManagerCache(
  create: (doc: Y.Doc) => Y.UndoManager,
): UndoManagerCache {
  const managers = new Map<string, Y.UndoManager>();

  /**
   * Destroy and drop the manager cached for a name.
   * @param name - The document name to evict.
   */
  const evict = (name: string): void => {
    const manager = managers.get(name);
    if (!manager) return;
    manager.destroy();
    managers.delete(name);
  };

  // Subscribing to every destroy is safe: evicting an unknown name is a no-op,
  // so a cache only ever drops its own entries.
  onDocDestroyed(evict);

  return {
    get(doc: Y.Doc, name: string): Y.UndoManager {
      let manager = managers.get(name);
      // Heal a stale binding: a manager created for a since-recreated doc is
      // observing a dead one. Guards against a caller that destroys a doc
      // without evicting.
      if (manager && manager.doc !== doc) {
        manager.destroy();
        manager = undefined;
      }
      if (!manager) {
        manager = create(doc);
        managers.set(name, manager);
      }
      return manager;
    },
    evict,
    has(name: string): boolean {
      return managers.has(name);
    },
    reset(): void {
      managers.forEach((manager) => manager.destroy());
      managers.clear();
    },
  };
}
