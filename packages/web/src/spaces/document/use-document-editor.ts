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

import type { CaretUserIdentity } from '@web/features/collab-editor/use-caret-user';
import { useCollabCaretPresence } from '@web/features/collab-editor/use-collab-caret-presence';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
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
  /**
   * Names for the collaborators whose carets appear in this document, resolved
   * from the project member roster (#1882). Without it their carets render as
   * bare coloured lines.
   */
  collaboratorNames?: CollaboratorNames | null;
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
   * every routine reconnect, and by then the content is already here — read it
   * from `useSocket`, which is the one place this is tracked.
   *
   * Required, and deliberately without a default. Either default is wrong for
   * somebody: `true` seeds into a document that may not have loaded, `false`
   * withholds an editor forever from a caller with no socket. A caller that
   * cannot answer it does not yet know whether it is safe to show this
   * document at all.
   */
  hasEverSynced: boolean;
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
 * @param options.collaboratorNames - Resolves collaborators' names from the roster.
 * @param options.editable - False for read-only.
 * @param options.hasEverSynced - Whether content has ever arrived; gates seeding.
 * @returns The editor and its undo manager, or null while the wiring is absent.
 */
export function useDocumentEditor({
  doc,
  name,
  caretProvider,
  caretUser,
  collaboratorNames = null,
  editable = true,
  hasEverSynced,
}: UseDocumentEditorOptions): DocumentEditorHandle | null {
  // Once the real content is known to be in, and only from a client whose ROLE
  // allows writing. A viewer's seed is refused by the server, which would
  // leave it a paragraph ahead of everyone else — the stray blank line this
  // exists to prevent, arriving from the other side. Seeding is idempotent, so
  // a re-run is free.
  //
  // `editable` is the ROLE, and only the role — a refused or read-only
  // connection is reported to the user rather than enforced against them
  // (decision 2026-08-02). So a client the server has quietly degraded to
  // read-only WILL still seed, and the server will drop that one update. It
  // costs a stray paragraph in that client's local copy until the next reload,
  // which is a smaller price than a document that mysteriously goes dead.
  React.useEffect(() => {
    if (hasEverSynced && editable) seedEmptyBody(doc);
  }, [doc, hasEverSynced, editable]);

  // Get-or-create, so the repeat calls a re-render causes are free and a
  // StrictMode double-invoke cannot produce a second editor.
  const handle = React.useMemo(
    () =>
      caretProvider && caretUser
        ? getDocumentEditor(doc, name, {
          caretProvider,
          caretUser,
          resolveCollaboratorName: collaboratorNames?.resolve,
          editable,
        })
        : null,
    // `editable` is deliberately NOT a dependency: it is construction-time
    // wiring, and the cache ignores its inputs on a hit. Later changes go
    // through `setEditable` in the effect below, which must not rebuild the
    // editor — that would discard the undo stack and the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, name, caretProvider, caretUser, collaboratorNames?.resolve],
  );

  // Editability flips without a rebuild — a role change or entering a history
  // preview must not discard the editor, its undo stack or its selection.
  React.useEffect(() => {
    const editor = handle?.editor;
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [handle, editable]);

  // Dim collaborators who have switched away, and tell them when we do.
  useCollabCaretPresence(
    handle?.editor ?? null,
    caretProvider,
    caretUser,
    collaboratorNames,
  );

  return handle;
}
