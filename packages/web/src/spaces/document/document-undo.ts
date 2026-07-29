// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document body's undo manager.
 *
 * It is built here and handed to the Collaboration extension rather than left
 * to the extension, for one reason: holding the manager beats looking it up.
 * The alternative is finding the undo plugin by its key NAME and reading the
 * manager out of its state, which misses silently if a second copy of the
 * binding ever enters the bundle — the key is then minted as `y-undo$1` and the
 * lookup simply returns nothing. A reference we created cannot go missing.
 *
 * Its lifetime is the editor's, which is what upstream assumes. That holds here
 * because the EDITOR outlives tab switches (see `document-editor-cache`), so
 * nothing has to be done to keep this manager alive across one — the earlier
 * shape of this file, which cached the manager and fought the binding's
 * teardown to keep it, is gone along with the problem it existed for.
 */

import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';

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
 * them. The alternative was a "remember to re-read afterwards" contract on each
 * caller, which the keyboard path had already quietly broken.
 */
export interface DocumentUndoManager extends Y.UndoManager {
  /**
   * Subscribe to undo / redo having run.
   * @param listener - Called after each undo or redo, effect or not.
   * @returns Unsubscribe.
   */
  onAfterHistoryAction: (listener: () => void) => () => void;
}

/**
 * Decide whether undo may delete one item, keeping the body in a state
 * ProseMirror can represent.
 *
 * Two rules, and the second is the reason this function exists rather than
 * `defaultDeleteFilter` alone.
 *
 * **A peer's words are not ours to take.** When two people write into the same
 * paragraph, undoing our own insert would take the whole paragraph and their
 * text with it. Upstream's filter is what prevents that, and it has to be
 * carried over: supplying our own manager means the binding never builds one,
 * so its defaults never apply. Measured, with this as the only difference:
 * Alice writes "hi", Bob appends "there" to the same paragraph, Alice presses
 * undo. Without the filter the paragraph ends up empty — Bob's text gone, the
 * deletion synced to everyone and absent from his undo stack.
 *
 * **The body may not be emptied outright.** ProseMirror's schema requires at
 * least one block, so an empty Y fragment is a state the editor cannot mirror:
 * its document still holds an empty paragraph the fragment no longer has. The
 * next dispatch of any kind — a click, a window focus, the remount a tab switch
 * causes — syncs that paragraph back, and because the sync plugin's origin is
 * tracked and nothing is being undone at that moment, yjs reads it as a fresh
 * local edit and clears the redo stack. The text the user just undid becomes
 * unrecoverable and the redo button goes dead. Upstream's filter does protect
 * paragraphs, but exempts ones of length zero, and yjs deletes children before
 * parents — so the paragraph is already empty by the time it is offered for
 * filtering, and the exemption lets it through every time.
 *
 * Refusing that last deletion leaves exactly what an empty ProseMirror document
 * is: one empty paragraph. The two agree, nothing is written back, and redo
 * survives. Measured: undo → any dispatch → redo restores the text, where
 * before the redo stack was already gone. Undoing several paragraphs still
 * collapses to one — only the final block is refused.
 * @param item - The item yjs is considering deleting.
 * @param body - The document body fragment this manager owns.
 * @returns True if the deletion may proceed.
 */
function keepBodyRepresentable(item: Y.Item, body: Y.XmlFragment): boolean {
  if (!defaultDeleteFilter(item, defaultProtectedNodes)) return false;
  const isDirectChild = (item as unknown as { parent?: unknown }).parent === body;
  return !(isDirectChild && body.length <= 1);
}

/**
 * Build an undo manager for a document's body.
 *
 * Tracking only the sync plugin's origin is what keeps a peer's edits off our
 * stack; {@link keepBodyRepresentable} is what keeps undo from damaging the
 * document, and carries the reasoning for both of its rules.
 *
 * `captureTransaction` honours the `addToHistory: false` marker, so
 * machine-driven edits stay off the stack.
 * @param doc - The document Space's Y.Doc.
 * @returns A manager bound to that document's body.
 */
export function createDocumentUndoManager(doc: Y.Doc): DocumentUndoManager {
  const body = documentBodyFragment(doc);
  const manager = new Y.UndoManager(body, {
    trackedOrigins: new Set([ySyncPluginKey]),
    deleteFilter: (item) => keepBodyRepresentable(item, body),
    captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
  }) as DocumentUndoManager;

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
