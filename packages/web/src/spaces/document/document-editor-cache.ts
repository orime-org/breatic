// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * Collaboration extension a manager built to outlive the editor. That was tried
 * and it is a dead end. The binding assumes the manager belongs to its editor
 * and releases its subscriptions by destroying it outright, so a manager that
 * refuses to die accumulates a listener pair per rebuild — each pinning a dead
 * editor view — while one that lets the teardown run loses either its document
 * attachment or, because upstream defers teardown past the next mount, the
 * incoming editor's subscriptions. Wrapping it to narrow the teardown then
 * splits its identity and silently disables the selection-restore fix, which
 * recognises an undo by comparing transaction origins. Three shapes, three
 * failures, one cause: the assumption being fought is upstream's, and it is a
 * reasonable one.
 *
 * Letting the editor outlive the switch drops the fight. The manager then
 * belongs to its editor exactly as upstream expects, and every one of those
 * problems stops existing rather than getting another layer.
 *
 * **Why this is supported, not a trick.** `EditorContent` already does the
 * hand-off: on unmount it moves the editor's DOM into a detached div and
 * re-points the editor at it; on mount it moves those nodes into the new
 * container. What destroys an editor is `useEditor`, which owns the instance it
 * creates. Building the editor outside React and passing it in leaves the DOM
 * hand-off intact and the lifetime ours. Measured across an unmount / remount:
 * `isDestroyed` false, DOM back inside the new container, text and undo stack
 * intact, later edits still reaching Yjs, remote updates still arriving.
 */

import { Editor } from '@tiptap/react';
import type * as Y from 'yjs';

import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import type { CaretUserIdentity } from '@web/features/collab-editor/use-caret-user';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import {
  createDocumentUndoManager,
  type DocumentUndoManager,
} from '@web/spaces/document/document-undo';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';

/** The editor plus the handles a caller needs alongside it. */
export interface DocumentEditorHandle {
  editor: Editor;
  /**
   * The editor's undo manager. Held rather than looked up by plugin-key name,
   * which misses silently against a duplicated copy of the binding.
   */
  undoManager: DocumentUndoManager;
}

/**
 * What the editor needs at construction and can never be given again.
 *
 * Both are baked into the extension list when the editor is built, and the
 * editor is built once per document. The caret layer therefore mounts only once
 * its provider exists, which is why the caller waits for one rather than
 * building an editor without carets and rebuilding later.
 */
export interface DocumentEditorInputs {
  /** Provider whose awareness carries collaborator carets. */
  caretProvider: { awareness: unknown };
  /** This user's caret identity, published to other clients. */
  caretUser: CaretUserIdentity;
  /**
   * Whether this client may type.
   *
   * Unlike the rest of this interface it is honoured on a cache HIT too — see
   * {@link getDocumentEditor}. It cannot wait for the effect that keeps it in
   * step, because TipTap defaults to editable and that effect runs after the
   * first paint.
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
  const editor = new Editor({
    extensions: buildDocumentExtensions({
      fragment: documentBodyFragment(doc),
      caretProvider: inputs.caretProvider,
      caretUser: inputs.caretUser,
      undoManager,
    }),
  });
  return { editor, undoManager };
}

const cache = createDocScopedCache<DocumentEditorHandle, DocumentEditorInputs>(
  createDocumentEditor,
  (handle) => handle.editor.destroy(),
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
  // Editability is settled HERE, on the way out, and nowhere else. TipTap
  // defaults to editable and the effect in `useDocumentEditor` that keeps it in
  // step runs after the first paint, so a viewer would otherwise get a
  // `contenteditable` document for a frame. Setting it at construction would
  // only cover a fresh editor — on a cache HIT the inputs are ignored by
  // design, because rebuilding would discard the undo stack and the selection.
  // One correction covering both paths beats two that overlap.
  if (!handle.editor.isDestroyed && handle.editor.isEditable !== inputs.editable) {
    handle.editor.setEditable(inputs.editable);
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
