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
 * So it is checked instead, in `__tests__/no-second-undo-stack`, for every
 * editor that exposes a builder the test can call. That is not all of them —
 * an editor composing its list inline inside a component cannot be reached — so
 * the test names its own gap rather than implying full coverage.
 */

import type { Extensions } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import type * as Y from 'yjs';

import type { CaretUserIdentity } from '@web/features/collab-editor/use-caret-user';
import { CollabCaretRefresh } from '@web/features/collab-editor/collab-caret-refresh';
import { CollabUndoSelection } from '@web/features/collab-editor/collab-undo-selection';
import {
  renderCollabCaret,
  renderCollabSelection,
  type CaretUser,
  type ResolveCollaboratorName,
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
   * Turns a remote collaborator's user id into a display name (#1882).
   *
   * Awareness carries no name, so without this every remote caret renders as
   * a bare coloured line. It must be reference-stable: the extension keeps
   * whatever it is given here for the editor's whole life, and this editor is
   * built once per document and never rebuilt.
   */
  resolveCollaboratorName?: ResolveCollaboratorName;
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
  const {
    fragment,
    caretProvider,
    caretUser,
    undoManager,
    resolveCollaboratorName,
  } = options;

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
        // Receiver-side render. The colour is derived from the remote user id
        // rather than read off the wire, so no remote string is ever inlined
        // into the DOM. BOTH builders are supplied — the default
        // selectionRender inlines the raw remote colour, and that omission is
        // exactly what an editor assembling this list by hand would miss.
        //
        // The name comes from the resolver, which is why this closure exists
        // at all: upstream calls `render(user, clientId)` and has nowhere to
        // put a third argument.
        //
        // DO NOT remove the resolver here as redundant plumbing. There is a
        // second path that also names carets — the presence hook patches the
        // label onto carets already on screen when the roster moves — and it
        // looks like it makes this one unnecessary, because deleting this
        // argument leaves the whole suite green nearly every time. Nearly.
        // Measured: with it deleted, the end-to-end caret test passed 9 runs
        // out of 10 and failed once, unchanged code both times.
        //
        // The two paths answer different questions. This one names a caret AT
        // BIRTH, synchronously, as part of building it. The presence hook
        // repaints an EXISTING caret, and it runs off the same awareness event
        // that produced the caret — so which of the two lands first is a race,
        // and the one-in-ten failure is that race being lost. Keeping this
        // means a caret is never briefly nameless; removing it means it
        // usually is not, which is a different promise.
        //
        // That difference is a frame wide, so no assertion here can hold it
        // down. This comment is the guard.
        // `clientId` stays optional so this still matches upstream's
        // single-argument `render` type. It arrives at runtime — the caret's
        // data-client-id, which the DOM patches key off, comes from it.
        render: (user: CaretUser, clientId?: number) =>
          renderCollabCaret(user, clientId, resolveCollaboratorName),
        selectionRender: renderCollabSelection,
      }),
    );
  }

  return extensions;
}
