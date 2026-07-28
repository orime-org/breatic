// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document body's undo manager, cached per document.
 *
 * We construct it ourselves and hand it to the Collaboration extension rather
 * than letting the extension build its own, for two reasons:
 *
 * 1. **A tab switch must not wipe the history.** The extension builds a fresh
 *    manager on every editor creation, and `SpaceOutlet` is keyed on the Space
 *    id, so switching tabs remounts the body. The text survives (it is in the
 *    Y.Doc) but the stack would not. Caching per document — the same fix the
 *    canvas arrived at — keeps the stack alive as long as the document is.
 * 2. **Holding the manager beats looking it up.** The alternative is finding
 *    the undo plugin by its key NAME and reading the manager out of its state,
 *    which fails silently if a second copy of the binding ever enters the
 *    bundle (the key is minted as `y-undo$1` and the lookup returns nothing).
 *    A reference we created cannot go missing.
 */

import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { createUndoManagerCache } from '@web/data/yjs/undo-manager-cache';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';

/**
 * Build an undo manager for a document's body.
 *
 * Tracking only the sync plugin's origin is what makes undo per-client: local
 * edits arrive tagged with it, a peer's edits arrive tagged by the provider,
 * so a peer's work is never on our stack and undo cannot reach across and
 * delete it.
 * @param doc - The document Space's Y.Doc.
 * @returns A manager bound to that document's body.
 */
function createDocumentUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(documentBodyFragment(doc), {
    trackedOrigins: new Set([ySyncPluginKey]),
  });
}

const documentUndoCache = createUndoManagerCache(createDocumentUndoManager);

/**
 * Get-or-create the cached undo manager for a document.
 *
 * Pass the same doc `getDoc(name)` returns; the manager observes that instance.
 * @param doc - The document Space's Y.Doc.
 * @param name - The canonical document name (cache key).
 * @returns The cached (or newly created) manager.
 */
export function getDocumentUndoManager(doc: Y.Doc, name: string): Y.UndoManager {
  return documentUndoCache.get(doc, name);
}

/**
 * Evict the cached manager for a document, clearing its history. Called when a
 * tab closes, so reopening the Space starts with an empty stack.
 * @param name - The canonical document name to evict.
 */
export function evictDocumentUndoManager(name: string): void {
  documentUndoCache.evict(name);
}

/**
 * Test-only: whether a manager is currently cached for a name.
 * @param name - The canonical document name.
 * @returns True while a manager is cached for that name.
 */
export function _hasDocumentUndoManagerForTests(name: string): boolean {
  return documentUndoCache.has(name);
}

/** Reset the cache (test helper — not for production use). */
export function _resetDocumentUndoCacheForTests(): void {
  documentUndoCache.reset();
}
