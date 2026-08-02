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
   * Whether this client may type, at the moment the editor is built.
   *
   * Construction-time only, like the rest of this interface — a later change
   * goes through `setEditable` on the living editor rather than rebuilding it.
   * It is here because the DEFAULT is editable, so leaving it to the effect
   * that follows would give a viewer a `contenteditable` document for its
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
    // Editability is set at CONSTRUCTION, not left to the effect that keeps it
    // in step afterwards. TipTap defaults to editable, so a viewer's editor
    // would otherwise be `contenteditable` from its first paint until that
    // effect runs — a window in which the document is not read-only at all.
    editable: inputs.editable,
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
  // On a cache HIT the inputs above are ignored by design — the editor is not
  // rebuilt, or it would lose the undo stack and the selection. But editability
  // must still be right from this render, not from an effect that runs after
  // the first paint: a viewer reopening a document someone editable had open
  // would otherwise get a `contenteditable` body for a frame.
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

/**
 * Test-only: whether an editor is currently cached for a name.
 * @param name - The canonical document name.
 * @returns True while an editor is cached for that name.
 */
export function _hasDocumentEditorForTests(name: string): boolean {
  return cache.has(name);
}

/** Reset the cache (test helper — not for production use). */
export function _resetDocumentEditorCacheForTests(): void {
  cache.reset();
}
