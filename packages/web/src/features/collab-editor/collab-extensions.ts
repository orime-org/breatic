// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one way to bind a TipTap editor to a Yjs document.
 *
 * Every collaborative editor in the product needs the same four things, and
 * getting any of them wrong is silent: history that belongs to the shared undo
 * manager rather than a second client-blind stack, a selection hand-off so undo
 * restores the caret, a caret refresh so collaborators do not vanish on Enter,
 * and caret rendering that never inlines a remote client's colour string.
 *
 * They were assembled by hand in each editor, which is how the document editor
 * shipped without the caret refresh: it was written by reading the canvas
 * editor and copying what looked necessary. The next editor — comments, a
 * timeline — would have done the same and dropped something else. So the list
 * lives here, once, and a new editor gets all of it by asking.
 *
 * What is deliberately NOT here: anything about a particular editor's content.
 * The schema, the placeholder, the mention chips are each editor's own business
 * — this module is only the collaboration wiring.
 *
 * ## The one thing this cannot do for you
 *
 * An editor that also carries its OWN history — StarterKit ships `UndoRedo` on
 * by default — ends up with two undo stacks, and the local one is blind to who
 * made each change: a peer's edit arrives as an ordinary local transaction, so
 * one Cmd+Z deletes their paragraph. Collaboration owns history, and the local
 * history has to be switched off by the editor that configures it, because that
 * is where the extension is added. Nothing here can reach it.
 *
 * So it is checked instead: `__tests__/no-second-undo-stack` asserts that every
 * editor built on this module resolves a schema without a local history plugin.
 * A new collaborative editor has to be added to that list — which is the point,
 * because being absent from it is the failure.
 */

import type { Extensions } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import type * as Y from 'yjs';

import type { CaretUserIdentity } from '@web/data/yjs/use-caret-user';
import { CollabCaretRefresh } from '@web/features/collab-editor/collab-caret-refresh';
import { CollabUndoSelection } from '@web/features/collab-editor/collab-undo-selection';
import {
  renderCollabCaret,
  renderCollabSelection,
} from '@web/features/collab-editor/caret-render';

/** What an editor has to supply to be bound to a shared document. */
export interface CollabExtensionOptions {
  /**
   * The fragment this editor edits.
   *
   * Required. It used to be optional, returning an empty list when absent —
   * which reads at the call site as "collaboration wired up" while silently
   * producing an editor with none of it. A caller that has no fragment yet
   * should not be calling this.
   */
  fragment: Y.XmlFragment;
  /**
   * Provider whose awareness carries collaborator carets. The caret extension
   * throws on a null provider, so carets mount only once this is present.
   */
  caretProvider?: { awareness: unknown } | null;
  /** This user's caret identity, published to other clients. */
  caretUser?: CaretUserIdentity | null;
  /**
   * An undo manager to bind instead of letting the collaboration extension
   * build its own. Supply it when the caller needs to READ the manager — a
   * plugin-key lookup fails silently against a duplicated binding.
   */
  undoManager?: Y.UndoManager;
}

/**
 * Build the collaboration half of an editor's extension list.
 * @param options - The document fragment and the caret wiring.
 * @returns The extensions to spread into the editor's own list.
 */
export function buildCollabExtensions(
  options: CollabExtensionOptions,
): Extensions {
  const { fragment, caretProvider, caretUser, undoManager } = options;

  const extensions: Extensions = [
    Collaboration.configure({
      fragment,
      ...(undoManager ? { yUndoOptions: { undoManager } } : {}),
    }),
    // Undo must restore the selection the edit started from. Upstream emits its
    // stack-item-popped hand-off AFTER the restore transaction has run, so the
    // editor keeps the caret where it was at undo time and the late write
    // lingers — the next remote change then applies that stale selection and
    // yanks the local caret. This hands the stored selection over in time.
    CollabUndoSelection,
    // y-tiptap clears every remote caret on a local structural edit and waits
    // for the collaborator to publish a new one. That wait never ends: they do
    // not know our document changed shape, and an idle client's awareness
    // heartbeats are deep-equal, so they never reach the cursor plugin. Without
    // this, one Enter blanks everyone else's caret until they happen to move.
    CollabCaretRefresh,
  ];

  // Carets need both an awareness-bearing provider and an identity to publish;
  // the extension throws when the provider is absent.
  if (caretProvider?.awareness && caretUser) {
    extensions.push(
      CollaborationCaret.configure({
        provider: caretProvider,
        user: caretUser,
        // Receiver-side safe render: a whitelisted hue resolves to a theme
        // token, so a remote client's colour string is never inlined into the
        // DOM. BOTH builders are supplied — the default selectionRender inlines
        // the raw remote colour too, and that omission is exactly what an
        // editor assembling this list by hand would miss.
        render: renderCollabCaret,
        selectionRender: renderCollabSelection,
      }),
    );
  }

  return extensions;
}
