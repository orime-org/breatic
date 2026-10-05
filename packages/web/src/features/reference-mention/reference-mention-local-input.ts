// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tracks, per transaction, whether the LAST doc change was a genuine LOCAL USER
 * keystroke — so the `@` suggestion popup's visibility follows the local user's
 * intent and is never resurrected by a machine-derived or remote edit (#1802).
 *
 * A local user keystroke is a doc-changing transaction that is NOT a remote
 * apply or an undo (a y-prosemirror apply carries the y-sync plugin key's meta;
 * the plain history plugin tags its own) and NOT a machine-derived dispatch
 * (tagged {@link MACHINE_EDIT_META}). Absence of a remote origin is not enough:
 * an editor's own machine writes carry none either. A follow-up
 * appendTransaction rides along with — and never overrides — the judgment of
 * the root transaction that triggered the update.
 */

import type { Editor } from '@tiptap/core';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { ySyncPluginKey } from '@web/features/collab-editor/collab-plugin-keys';

/**
 * Meta key a MACHINE-DERIVED (non-user-typed) local editor transaction sets so
 * the local-input tracker does not mistake it for a keystroke. Set it on every
 * programmatic `editor.view.dispatch` that is a CONSEQUENCE of a change outside
 * the editor rather than a keypress. A y-prosemirror apply (remote peer edit or
 * local yUndo) needs no marker: it already carries the y-sync plugin key's meta.
 */
export const MACHINE_EDIT_META = 'referenceMentionMachineEdit';

/** Plugin key for the per-transaction local-user-input judgment. */
const LOCAL_USER_INPUT_KEY = new PluginKey<boolean>(
  'referenceMentionLocalUserInput',
);

/**
 * Builds the ProseMirror plugin that maintains, per transaction, whether the
 * last doc change was a local user keystroke. Installed by the editor's
 * reference node alongside the caret plugin. Computing this in `apply` (before the plugin `view().update`
 * that drives the suggestion callbacks) means there is no read-the-settled-state
 * race — the judgment is fixed by the transaction that triggered the update.
 * @returns The tracker plugin.
 * @throws {never}
 */
export function createLocalUserInputTracker(): Plugin<boolean> {
  return new Plugin<boolean>({
    key: LOCAL_USER_INPUT_KEY,
    state: {
      init: (): boolean => false,
      /**
       * Recomputes the local-user-input judgment for one applied transaction.
       * @param tr - The applied transaction.
       * @param value - The previous judgment.
       * @returns Whether the last intent-bearing change was local user input.
       */
      apply: (tr, value): boolean => {
        // A follow-up appended by another plugin's appendTransaction (e.g. the
        // caret whitespace normalizer) carries ProseMirror's internal
        // `appendedTransaction` meta. It rides WITH the root transaction that
        // triggered this update, so it must not overwrite the root's judgment —
        // otherwise a machine append after a remote edit would mask the remote
        // origin (the settled-state hole round 4 found).
        if (tr.getMeta('appendedTransaction')) return value;
        // A machine dispatch is never the reader's input, whether or not it
        // changes the doc itself: a meta-only one can still have follow-ups
        // appended that move the `@` range, and those ride on this judgment.
        if (tr.getMeta(MACHINE_EDIT_META) === true) return false;
        // Intent-bearing = doc change OR selection change (#1805): a local
        // CARET PLACEMENT — pointer click or arrow key — is user input too,
        // even though it changes no content. The suggestion's onStart fires
        // off exactly such a movement (clicking after an existing `@`), and a
        // tracker that only judged doc changes read "non-local" there, hiding
        // a picker the local user just asked for. Meta-only transactions
        // (awareness updates, plugin bookkeeping) carry no intent signal.
        if (!tr.docChanged && !tr.selectionSet) return value;
        // Remote peer edit OR local yUndo/redo: y-prosemirror tags the
        // transaction with the y-sync plugin key's meta, read here through the
        // key itself ({@link ySyncPluginKey}). A yUndo is not a keystroke
        // either — undo is not an intent to open the picker — so, unlike the old
        // discriminator, it does not re-show a dismissed popup. Selection-only
        // transactions are produced by LOCAL input (prosemirror-view
        // pointer/keyboard handling); remote applies are doc transactions, so
        // the same test classifies them correctly. An editor with no
        // collaboration undoes through the plain history plugin instead, which
        // tags its own transactions.
        return tr.getMeta(ySyncPluginKey) === undefined && !isHistoryTransaction(tr);
      },
    },
  });
}

/**
 * Whether the LAST doc-changing transaction on the editor was a genuine LOCAL
 * USER keystroke (not a remote peer edit, a local yUndo, or a machine-derived
 * dispatch). The `@` suggestion uses it to drive popup visibility by local
 * intent only. Returns false when the tracker plugin is absent (a bare editor).
 * @param editor - The editor.
 * @returns True when the last doc change was a local user keystroke.
 * @throws {never}
 */
export function wasLastChangeLocalUserInput(editor: Editor): boolean {
  return LOCAL_USER_INPUT_KEY.getState(editor.state) ?? false;
}

/**
 * Dispatches a MACHINE-DERIVED (non-user-typed) edit on an editor,
 * applying BOTH machine-edit invariants in one place: keep it OUT of the
 * collaborative undo stack (addToHistory:false, so Cmd+Z reverts the user's own
 * edit rather than a machine cosmetic sync / edge-driven delete) AND tag it
 * MACHINE_EDIT_META so {@link wasLastChangeLocalUserInput} never counts it as a
 * keystroke (so it can never resurrect a dismissed `@` popup — #1802 round-4).
 * Every machine effect on the editor dispatches through this, so both
 * invariants hold by construction.
 * @param view - The editor view.
 * @param tr - The prepared transaction (its content already staged by the caller).
 * @throws {never}
 */
export function dispatchMachineEdit(view: EditorView, tr: Transaction): void {
  tr.setMeta('addToHistory', false);
  tr.setMeta(MACHINE_EDIT_META, true);
  view.dispatch(tr);
}
