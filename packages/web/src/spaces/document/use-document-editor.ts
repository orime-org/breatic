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

import type { CaretUserIdentity } from '@web/data/yjs/use-caret-user';
import { useCollabCaretFocus } from '@web/data/yjs/use-collab-caret-focus';
import {
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { seedEmptyBody } from '@web/spaces/document/document-yjs';

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
  /** This user's caret identity, published to other clients. */
  caretUser: CaretUserIdentity | null;
  /** False puts the editor in read-only mode (viewer role, history preview). */
  editable?: boolean;
  /**
   * Whether this document's real content has arrived at least once.
   *
   * Gates the seeding in {@link seedEmptyBody}: a body that is empty because
   * it has not loaded yet must not be seeded, or the server's real content
   * merges in behind the seeded paragraph and leaves a stray blank line.
   *
   * EVER, not currently. A live "is the socket in sync" flag drops to false on
   * every routine reconnect, and by then the content is already here.
   */
  hasSynced?: boolean;
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
 * @param options.caretUser - This user's caret identity.
 * @param options.editable - False for read-only.
 * @param options.hasSynced - Whether content has ever arrived; gates seeding.
 * @returns The editor and its undo manager, or null while the wiring is absent.
 */
export function useDocumentEditor({
  doc,
  name,
  caretProvider,
  caretUser,
  editable = true,
  hasSynced = true,
}: UseDocumentEditorOptions): DocumentEditorHandle | null {
  // Once the real content is known to be in, and only from a client allowed to
  // write. A read-only client's seed is refused by the server, which would
  // leave it a paragraph ahead of everyone else — the stray blank line this
  // exists to prevent, arriving from the other side. Seeding is idempotent, so
  // a re-run is free.
  //
  // `editable` is the role, which is the only signal the client has; a
  // connection downgraded to read-only for other reasons (a per-document
  // connection cap) still reads as editable here. Everything such a client
  // types is refused too, so that is a wider gap than seeding.
  React.useEffect(() => {
    if (hasSynced && editable) seedEmptyBody(doc);
  }, [doc, hasSynced, editable]);

  // Get-or-create, so the repeat calls a re-render causes are free and a
  // StrictMode double-invoke cannot produce a second editor.
  const handle = React.useMemo(
    () =>
      caretProvider && caretUser
        ? getDocumentEditor(doc, name, { caretProvider, caretUser })
        : null,
    [doc, name, caretProvider, caretUser],
  );

  // Editability flips without a rebuild — a role change or entering a history
  // preview must not discard the editor, its undo stack or its selection.
  React.useEffect(() => {
    const editor = handle?.editor;
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [handle, editable]);

  // Dim collaborators who have switched away, and tell them when we do.
  useCollabCaretFocus(handle?.editor ?? null, caretProvider, caretUser);

  return handle;
}
