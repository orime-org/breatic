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

import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { createUndoManagerCache } from '@web/data/yjs/undo-manager-cache';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';

/**
 * An undo manager that reports every undo and redo, including the ones that
 * change nothing.
 *
 * yjs discards stack entries whose content a collaborator has since deleted,
 * and since undoing such an entry alters nothing it announces nothing either —
 * no event fires, and anything mirroring availability from events goes stale.
 * The manager therefore reports the ACTION rather than its effect, so a reader
 * always gets a chance to re-check.
 *
 * Every path — the toolbar, the keyboard shortcuts, a direct command — ends up
 * calling `undo()` / `redo()` on this object, so reporting here covers all of
 * them. The alternative was a "remember to re-read afterwards" contract on
 * each caller, which the keyboard path had already quietly broken.
 */
export interface DocumentUndoManager extends Y.UndoManager {
  /**
   * Subscribe to undo / redo having run.
   * @param listener - Called after each undo or redo, effect or not.
   * @returns Unsubscribe.
   */
  onAfterHistoryAction: (listener: () => void) => () => void;
  /**
   * Really shut the manager down. `destroy()` is inert on this object so an
   * unmounting editor cannot end a manager meant to outlive it; only the cache
   * calls this.
   */
  shutDown: () => void;
}

/**
 * Build an undo manager for a document's body.
 *
 * Tracking only the sync plugin's origin is what keeps a peer's edits off our
 * stack. But that alone is not enough to keep undo from destroying their work:
 * when two people write into the SAME paragraph, undoing our own insert takes
 * the whole paragraph — their text with it. The binding guards against exactly
 * this with a delete filter, which we have to carry over because supplying our
 * own manager means the binding never builds one and its defaults never apply.
 *
 * Measured, with the two options being the only difference: Alice writes "hi",
 * Bob appends "there" to the same paragraph, Alice presses undo. Without the
 * filter the paragraph ends up empty — Bob's text gone, the deletion synced to
 * everyone and absent from his undo stack. With it, "there" remains.
 *
 * `captureTransaction` comes along for the same reason: it is what honours the
 * `addToHistory: false` marker, so machine-driven edits stay off the stack.
 * @param doc - The document Space's Y.Doc.
 * @returns A manager bound to that document's body.
 */
function createDocumentUndoManager(doc: Y.Doc): DocumentUndoManager {
  const manager = new Y.UndoManager(documentBodyFragment(doc), {
    trackedOrigins: new Set([ySyncPluginKey]),
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
    captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
  }) as DocumentUndoManager;

  // The binding tears the manager down when its editor unmounts, handing back a
  // `restore` for the next editor to call. That dance assumes ONE editor being
  // remounted; ours is a different editor each time, and React does not promise
  // the outgoing cleanup runs before the incoming setup. Measured: the incoming
  // editor looks for `restore` (not set yet), the outgoing one then detaches the
  // manager from the document and sets it — so the listener is gone with nobody
  // left to put it back, and every edit from then on goes unrecorded.
  //
  // This manager is meant to outlive editors, so it opts out of that protocol:
  // teardown is inert, `restore` is swallowed, and only the cache — which knows
  // when the document itself is gone — really ends it.
  const shutDown = manager.destroy.bind(manager);
  manager.destroy = (): void => {};
  Object.defineProperty(manager, 'restore', {
    get: () => undefined,
    set: () => {},
    configurable: true,
  });
  manager.shutDown = shutDown;

  const listeners = new Set<() => void>();
  const undo = manager.undo.bind(manager);
  const redo = manager.redo.bind(manager);
  /** Tells subscribers an action ran, whatever it did or did not change. */
  const announce = (): void => {
    listeners.forEach((listener) => listener());
  };
  manager.undo = (): ReturnType<Y.UndoManager['undo']> => {
    const item = undo();
    announce();
    return item;
  };
  manager.redo = (): ReturnType<Y.UndoManager['redo']> => {
    const item = redo();
    announce();
    return item;
  };
  manager.onAfterHistoryAction = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  };

  return manager;
}

const documentUndoCache = createUndoManagerCache(createDocumentUndoManager, (manager) =>
  manager.shutDown(),
);

/**
 * Get-or-create the cached undo manager for a document.
 *
 * Pass the same doc `getDoc(name)` returns; the manager observes that instance.
 * @param doc - The document Space's Y.Doc.
 * @param name - The canonical document name (cache key).
 * @returns The cached (or newly created) manager.
 */
export function getDocumentUndoManager(
  doc: Y.Doc,
  name: string,
): DocumentUndoManager {
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
