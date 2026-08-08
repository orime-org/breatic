// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Resolves the document editor for a Space and keeps it in step with props.
 *
 * The editor itself is not created here — it belongs to the document, not to
 * this component, and is built once and kept in {@link getDocumentEditor}. See
 * that module for why the editor rather than just its history is what survives
 * a Space tab switch.
 *
 * What is left for the hook is the part that genuinely changes while an editor
 * lives: whether it is editable, and whether this client's caret should read as
 * present or away.
 */

import * as React from 'react';
import type * as Y from 'yjs';

import { useCollabCaretPresence } from '@web/features/collab-editor/use-collab-caret-presence';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import {
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';

/** Inputs for {@link useDocumentEditor}. */
export interface UseDocumentEditorOptions {
  /** The Space's Y.Doc; pass the one `getDoc(name)` returns. */
  doc: Y.Doc;
  /** The canonical document name, which is also the editor's cache key. */
  name: string;
  /**
   * Provider whose awareness carries collaborator carets. Null until the
   * session resolves; the editor waits for it rather than being built without
   * carets and rebuilt later.
   */
  caretProvider: { awareness: unknown } | null;
  /** False puts the editor in read-only mode (viewer role, history preview). */
  editable?: boolean;
}

/**
 * Resolve the document's editor.
 *
 * Returns null until the caret wiring is available, because both pieces are
 * baked into the editor at construction and it is only constructed once. In
 * practice that is a single extra render: the provider comes from a
 * reference-counted registry that already holds this document open, so its
 * arrival waits on the session resolving, not on the network.
 * @param options - Which document, plus the collaborative wiring.
 * @param options.doc - The Space's Y.Doc.
 * @param options.name - The canonical document name (cache key).
 * @param options.caretProvider - Provider whose awareness carries carets.
 * @param options.editable - False for read-only.
 * @returns The editor and its undo manager, or null while the wiring is absent.
 */
export function useDocumentEditor({
  doc,
  name,
  caretProvider,
  editable = true,
}: UseDocumentEditorOptions): DocumentEditorHandle | null {
  // From context, not from a prop: the roster is a project-level fact and every
  // layer between here and the project page used to have to forward it.
  const collaboratorNames = useCollaboratorNames();
  // This hook used to seed an empty body with the one paragraph ProseMirror
  // insists on, behind two guards: only after the content had arrived, and
  // only from a client whose role allows writing. Both are gone with the seed
  // itself — the body now holds a paragraph from the moment the backend
  // creates the Space, so there is nothing here to repair. `@breatic/shared`'s
  // `document-body` module carries the invariant and why it belongs there.

  // Get-or-create, so the repeat calls a re-render causes are free and a
  // StrictMode double-invoke cannot produce a second editor.
  const handle = React.useMemo(
    () =>
      caretProvider
        ? getDocumentEditor(doc, name, {
          caretProvider,
          resolveCollaboratorName: collaboratorNames?.resolve,
          editable,
        })
        : null,
    // `editable` is deliberately NOT a dependency: it is construction-time
    // wiring, and the cache ignores its inputs on a hit. Later changes go
    // through `setEditable` in the effect below, which must not rebuild the
    // editor — that would discard the undo stack and the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, name, caretProvider, collaboratorNames?.resolve],
  );

  // Editability flips without a rebuild — a role change or entering a history
  // preview must not discard the editor, its undo stack or its selection.
  React.useEffect(() => {
    const editor = handle?.editor;
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [handle, editable]);

  // Dim collaborators who have switched away, and tell them when we do.
  useCollabCaretPresence(handle?.editor ?? null, caretProvider);

  return handle;
}
