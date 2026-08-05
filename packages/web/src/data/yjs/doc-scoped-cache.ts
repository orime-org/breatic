// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A process-wide cache for state whose lifetime is a document's, not a
 * component's, keyed by document name.
 *
 * Two kinds of state live only in memory and are never written to the Y.Doc: an
 * undo stack, and an editor instance with its selection and input-method state.
 * Both are lost if a React component owns them, because switching Space tabs
 * remounts the body — `SpaceOutlet` is keyed on the Space id. The text
 * survives, since that IS in the Y.Doc; everything around it silently does not.
 *
 * Binding such state to the DOCUMENT instead — the same lifetime as the cached
 * `Y.Doc` — is what makes a tab switch harmless. Callers differ only in how
 * their value is built and torn down, so both are parameters.
 */

import type * as Y from 'yjs';

import { onDocDestroyed } from '@web/data/yjs/manager';

/**
 * A per-document cache of some resource.
 *
 * `TInputs` is whatever the value needs at construction beyond the document
 * itself — `void` when the document is enough.
 */
export interface DocScopedCache<TValue, TInputs = void> {
  /**
   * Get-or-create the value for a document. The first call builds one; later
   * calls return the same instance, so whatever it holds survives a tab
   * switch. Pass the SAME doc `getDoc(name)` returns.
   *
   * `inputs` applies only to a construction: a call for a document that already
   * has a value returns it and ignores them, since not rebuilding is the point.
   */
  get: (doc: Y.Doc, name: string, inputs: TInputs) => TValue;
  /**
   * Tear down and drop the value for a document. Called when a tab closes, so
   * reopening the Space starts clean. No-op for an unknown name.
   */
  evict: (name: string) => void;
  /** Test helper — whether a value is currently cached for a name. */
  has: (name: string) => boolean;
  /** Test helper — tear down and drop every cached value. */
  reset: () => void;
}

/** A cached value alongside the document it was built for. */
interface Entry<TValue> {
  value: TValue;
  doc: Y.Doc;
}

/**
 * Build a document-scoped cache around a construction and a teardown function.
 *
 * The returned cache evicts itself whenever a document is destroyed: the doc
 * lives in the manager registry and dies when its last provider releases, and a
 * value left behind would keep that dead doc's content pinned — relocating the
 * leak the doc eviction exists to fix, rather than fixing it.
 * @param create - Builds the value for a document; called on a cache miss.
 * @param dispose - Ends a value on eviction.
 * @returns The cache.
 */
export function createDocScopedCache<TValue, TInputs = void>(
  create: (doc: Y.Doc, inputs: TInputs) => TValue,
  dispose: (value: TValue) => void,
): DocScopedCache<TValue, TInputs> {
  const entries = new Map<string, Entry<TValue>>();

  /**
   * Tear down and drop the value cached for a name.
   * @param name - The document name to evict.
   */
  const evict = (name: string): void => {
    const entry = entries.get(name);
    if (!entry) return;
    dispose(entry.value);
    entries.delete(name);
  };

  // Subscribing to every destroy is safe: evicting an unknown name is a no-op,
  // so a cache only ever drops its own entries.
  onDocDestroyed(evict);

  return {
    get(doc: Y.Doc, name: string, inputs: TInputs): TValue {
      const existing = entries.get(name);
      // Heal a stale binding: a value built for a since-recreated doc is bound
      // to a dead one. Guards against a caller that destroys a doc without
      // evicting. The document is remembered alongside the value rather than
      // read back off it, so this works for values that expose no `doc`.
      if (existing && existing.doc !== doc) {
        dispose(existing.value);
        entries.delete(name);
      }
      const current = entries.get(name);
      if (current) return current.value;
      const value = create(doc, inputs);
      entries.set(name, { value, doc });
      return value;
    },
    evict,
    has(name: string): boolean {
      return entries.has(name);
    },
    reset(): void {
      entries.forEach((entry) => dispose(entry.value));
      entries.clear();
    },
  };
}
