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
 * Build an undo manager for a document's body.
 *
 * Tracking only the sync plugin's origin is what keeps a peer's edits off our
 * stack. But that alone would not stop undo from destroying their work: when
 * two people write into the SAME paragraph, undoing our own insert takes the
 * whole paragraph — their text with it. The binding guards against exactly this
 * with a delete filter, which has to be carried over here because supplying our
 * own manager means the binding never builds one and its defaults never apply.
 * Measured, with the filter as the only difference: Alice writes "hi", Bob
 * appends "there" to the same paragraph, Alice presses undo. Without it the
 * paragraph ends up empty — Bob's text gone, the deletion synced to everyone
 * and absent from his undo stack.
 *
 * The filter is upstream's, unmodified. An earlier version of this file added a
 * rule refusing to delete the body's last child, to stop undo emptying the
 * fragment; `seedEmptyBody` in `document-yjs` removes the need by keeping a
 * paragraph there from the start, which also covers the block types the extra
 * rule could not
 * (an empty list or blockquote violates the schema and gets deleted anyway).
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
    deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
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
