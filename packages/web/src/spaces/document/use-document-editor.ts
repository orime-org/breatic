// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Creates the document editor and keeps it bound to the Space's Yjs document.
 *
 * Split out from the component so the binding and its undo semantics can be
 * exercised directly — collaborative undo is per-client and getting it wrong
 * silently destroys a co-editor's work, which is not something to verify only
 * through the UI.
 */

import type { Editor } from '@tiptap/react';
import { useEditor } from '@tiptap/react';
import * as React from 'react';
import type * as Y from 'yjs';

import { useCollabCaretFocus } from '@web/data/yjs/use-collab-caret-focus';
import {
  buildDocumentExtensions,
  type DocumentCaretUser,
} from '@web/spaces/document/document-extensions';

/** Inputs for {@link useDocumentEditor}. */
export interface UseDocumentEditorOptions {
  /** The document body fragment — the collaborative binding target. */
  fragment: Y.XmlFragment;
  /**
   * Provider whose awareness carries collaborator carets. Null until the
   * socket connects; the caret layer mounts once it arrives.
   */
  caretProvider?: { awareness: unknown } | null;
  /** This user's caret identity, published to other clients. */
  caretUser?: DocumentCaretUser | null;
  /** Empty-state text. */
  placeholder?: string;
  /** False puts the editor in read-only mode (viewer role, history preview). */
  editable?: boolean;
  /**
   * The undo manager to use. Supplying one keeps the history alive when the
   * editor is rebuilt — which a Space tab switch always causes.
   */
  undoManager?: Y.UndoManager;
}

/**
 * Build the document editor bound to `fragment`.
 *
 * History comes from the Collaboration extension's shared undo manager, which
 * tracks only this client's own transactions — a peer's edits are never on our
 * stack, so undo can't reach across and delete their work.
 * @param options - Binding target plus the optional collaborative layers.
 * @param options.fragment - The document body fragment to bind to.
 * @param options.caretProvider - Provider whose awareness carries collaborator carets.
 * @param options.caretUser - This user's caret identity, published to other clients.
 * @param options.placeholder - Empty-state text.
 * @param options.editable - False puts the editor in read-only mode.
 * @param options.undoManager - Undo manager that outlives the editor rebuild.
 * @returns The editor, or null until it has mounted.
 */
export function useDocumentEditor({
  fragment,
  caretProvider = null,
  caretUser = null,
  placeholder,
  editable = true,
  undoManager,
}: UseDocumentEditorOptions): Editor | null {
  const editor = useEditor(
    {
      extensions: buildDocumentExtensions({
        fragment,
        caretProvider,
        caretUser,
        placeholder,
        undoManager,
      }),
      // The editor mounts asynchronously; rendering it synchronously breaks
      // hydration and is what upstream recommends against.
      immediatelyRender: false,
      editable,
    },
    // Rebuild only on inputs baked into the extension list at creation time.
    // `placeholder` is a STRING, not the translator function: the translator's
    // identity is stable across a locale switch, so depending on it would leave
    // the placeholder stuck in the previous language.
    [fragment, caretProvider, caretUser, placeholder, undoManager],
  );

  // Editability flips without a rebuild — a role change or entering a history
  // preview must not discard the editor and its undo stack.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // Dim collaborators who have switched away, and tell them when we do.
  useCollabCaretFocus(editor, caretProvider, caretUser);

  return editor;
}
