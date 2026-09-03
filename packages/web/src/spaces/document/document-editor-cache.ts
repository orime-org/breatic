// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document editor, cached per document instead of per component.
 *
 * **Why the editor and not just its history.** Switching Space tabs remounts
 * the body — `SpaceOutlet` is keyed on the Space id — and an editor owned by
 * that component dies with it. The text survives, because it is in the Y.Doc;
 * the undo stack, the selection and any in-flight input-method composition do
 * not. (The scroll position is NOT among them: the scroller is the `ScrollArea`
 * around the editor, which belongs to the component and is rebuilt with it.
 * Carrying that across would be a separate change.)
 *
 * The narrower response is to rescue the undo stack alone, by handing the
 * collaboration a manager built to outlive the editor. That was tried and it is
 * a dead end. The binding assumes the manager belongs to its editor and
 * releases its subscriptions by destroying it outright — `yUndoPlugin`'s view
 * teardown calls `undoManager.destroy()` (`y-prosemirror.cjs:2182-2183`) — so a
 * manager that refuses to die accumulates a listener pair per rebuild, each
 * pinning a dead editor view, while one that lets the teardown run loses its
 * document attachment. Three shapes, three failures, one cause: the assumption
 * being fought is upstream's, and it is a reasonable one.
 *
 * Letting the editor outlive the switch drops the fight. The manager then
 * belongs to its editor exactly as upstream expects.
 *
 * **What makes the hand-off work here.** `unmount()` is a teardown rather than
 * a detach: it runs the plugin views' destroy, and two of those take the
 * collaboration apart — the sync plugin's calls `binding.destroy()`
 * (`y-prosemirror.cjs:309-310`), the undo plugin's the line above. So the body
 * must never unmount on its way out; it mounts the same editor into the new
 * container instead, and the old DOM comes with it. Measured across such a
 * hand-off in `document-editor-outlives-its-mount`: text present in the new
 * container, undo stack intact, later edits still reaching Yjs.
 *
 * Evicting a closed tab's editor IS that teardown, which is why this file
 * unmounts there and nowhere else.
 */

import type * as Y from 'yjs';
import type { BlockNoteEditor } from '@blocknote/core';

import { documentBodyFragment } from '@breatic/shared';

import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import type { ResolveCollaboratorName } from '@web/features/collab-editor/caret-render';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentChordsExtension } from '@web/spaces/document/document-block-chords';
import { documentCaretExtension } from '@web/spaces/document/document-caret';
import { documentDecorationsExtension } from '@web/spaces/document/document-decorations';
import { documentLocaleRedrawExtension } from '@web/spaces/document/document-locale-redraw';
import { documentPlaceholderExtension } from '@web/spaces/document/document-placeholders-blocknote';
import { documentSelectAllExtension } from '@web/spaces/document/document-select-all-guard';
import {
  createDocumentUndoManager,
  documentUndoExtension,
} from '@web/spaces/document/document-undo-blocknote';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';

/** The editor plus what is handed out alongside it. */
export interface DocumentEditorHandle {
  /** The live editor, owned by this cache rather than by any component. */
  editor: BlockNoteEditor<never, never, never>;
  /**
   * The editor's undo manager, held rather than looked up. Its readers are the
   * tests, which assert on the undo stack directly; the extensions get it from
   * the local it is built in.
   */
  undoManager: Y.UndoManager;
  /**
   * Subscribe to the guarded whole-document delete asking for confirmation.
   *
   * The ask is wired into the extensions at construction, and the editor
   * outlives any one mount — so the extension cannot hold a component's
   * callback. It emits here instead, and whichever `DocumentSpace` is mounted
   * subscribes for its lifetime and shows the dialog.
   * @param listener - Called each time the delete keys land on a
   *   whole-document selection.
   * @returns Unsubscribe.
   */
  onClearDocumentRequest: (listener: () => void) => () => void;
}

/**
 * What the editor needs at construction and can never be given again.
 *
 * The caret wiring is baked into the extension list when the editor is built,
 * and the editor is built once per document. The caret layer therefore mounts
 * only once its provider exists, which is why the caller waits for one rather
 * than building an editor without carets and rebuilding later.
 */
export interface DocumentEditorInputs {
  /** Provider whose awareness carries collaborator carets. */
  caretProvider: { awareness: unknown };
  /** Resolves collaborators' display names from the project roster (#1882). */
  resolveCollaboratorName?: ResolveCollaboratorName;
  /**
   * Whether this client may type.
   *
   * Unlike the rest of this interface it is honoured on a cache HIT too — see
   * {@link getDocumentEditor}. It cannot wait for the effect that keeps it in
   * step, because the editor defaults to editable and that effect runs after
   * the first paint.
   */
  editable: boolean;
}

/**
 * Build the editor for a document.
 * @param doc - The document Space's Y.Doc.
 * @param inputs - Construction-time collaborative wiring.
 * @returns The editor and its undo manager.
 */
function createDocumentEditor(
  doc: Y.Doc,
  inputs: DocumentEditorInputs,
): DocumentEditorHandle {
  const undoManager = createDocumentUndoManager(doc);
  const clearListeners = new Set<() => void>();

  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [
      // The awareness is withheld from BlockNote's own collaboration wiring and
      // handed to this plugin instead; `build-document-editor` carries why.
      documentCaretExtension(
        inputs.caretProvider.awareness as never,
        inputs.resolveCollaboratorName,
      ),
      documentUndoExtension(undoManager),
      documentSelectAllExtension(() => {
        clearListeners.forEach((listener) => {
          listener();
        });
      }),
      documentChordsExtension(),
      documentDecorationsExtension(),
      documentFallbackExtension(),
      documentPlaceholderExtension(),
      documentLocaleRedrawExtension(),
    ],
  });

  return {
    editor,
    undoManager,
    onClearDocumentRequest: (listener) => {
      clearListeners.add(listener);
      return () => {
        clearListeners.delete(listener);
      };
    },
  };
}

const cache = createDocScopedCache<DocumentEditorHandle, DocumentEditorInputs>(
  createDocumentEditor,
  (handle) => {
    handle.editor.unmount();
  },
);

/**
 * Get-or-create the editor for a document.
 * @param doc - The document Space's Y.Doc; pass the one `getDoc(name)` returns.
 * @param name - The canonical document name (cache key).
 * @param inputs - Construction-time wiring; ignored if an editor already exists.
 * @returns The cached (or newly built) editor and its undo manager.
 */
export function getDocumentEditor(
  doc: Y.Doc,
  name: string,
  inputs: DocumentEditorInputs,
): DocumentEditorHandle {
  const handle = cache.get(doc, name, inputs);
  // Editability is settled HERE, on the way out, and nowhere else. The editor
  // defaults to editable and the effect in `useDocumentEditor` that keeps it in
  // step runs after the first paint, so a viewer would otherwise get a writable
  // document for a frame. Setting it at construction would only cover a fresh
  // editor — on a cache HIT the inputs are ignored by design, because
  // rebuilding would discard the undo stack and the selection. One correction
  // covering both paths beats two that overlap.
  if (handle.editor.isEditable !== inputs.editable) {
    handle.editor.isEditable = inputs.editable;
  }
  return handle;
}

/**
 * Destroy and drop the editor for a document. Called when a tab closes, so
 * reopening the Space starts with a fresh editor and an empty history.
 * @param name - The canonical document name to evict.
 */
export function evictDocumentEditor(name: string): void {
  cache.evict(name);
}

/** Reset the cache (test helper — not for production use). */
export function _resetDocumentEditorCacheForTests(): void {
  cache.reset();
}
