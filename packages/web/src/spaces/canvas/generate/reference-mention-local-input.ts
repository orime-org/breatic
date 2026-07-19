// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tracks, per transaction, whether the LAST doc change was a genuine LOCAL USER
 * keystroke — so the `@` suggestion popup's visibility follows the local user's
 * intent and is never resurrected by a machine-derived or remote edit
 * (collaboration residual 1, #1802).
 *
 * This POSITIVE identification replaces the earlier `wasLastChangeRemote`
 * reverse-inference (read the settled y-sync `isChangeOrigin` and assume
 * "not remote" == "the user typed"). That assumption was structurally wrong on
 * two counts the round-4 adversarial pass exposed:
 *   1. A LOCAL machine-derived transaction — the edge-driven cascade-clear that
 *      deletes a chip when its reference leaves the pool (PromptEditor), or a
 *      chip display re-sync — carries no remote origin yet is not a keystroke
 *      either, so "not remote" wrongly resurrected a dismissed popup.
 *   2. It read the SETTLED state, so an appendTransaction follow-up (the caret
 *      whitespace normalizer) running after a remote edit overwrote the remote
 *      origin and masked it.
 *
 * A local user keystroke is a doc-changing transaction that is NOT a
 * y-prosemirror apply (a remote peer edit OR a local yUndo — both tagged with
 * the y-sync plugin key's meta) and NOT a machine-derived dispatch (tagged
 * {@link MACHINE_EDIT_META}). A follow-up appendTransaction rides along with —
 * and never overrides — the judgment of the root transaction that triggered the
 * update.
 */

import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Meta key a MACHINE-DERIVED (non-user-typed) local editor transaction sets so
 * the local-input tracker does not mistake it for a keystroke. Set it on every
 * programmatic `editor.view.dispatch` that is a CONSEQUENCE of a canvas / data
 * change rather than a keypress — the edge-driven cascade-clear and the chip
 * display re-sync in PromptEditor. A y-prosemirror apply (remote peer edit or
 * local yUndo) needs no marker: it already carries the y-sync plugin key's meta.
 */
export const MACHINE_EDIT_META = 'referenceMentionMachineEdit';

/** Plugin key for the per-transaction local-user-input judgment. */
const LOCAL_USER_INPUT_KEY = new PluginKey<boolean>(
  'referenceMentionLocalUserInput',
);

/**
 * Builds the ProseMirror plugin that maintains, per transaction, whether the
 * last doc change was a local user keystroke. Installed by the ReferenceMention
 * node (addProseMirrorPlugins) so it rides on the prompt editor alongside the
 * caret plugin. Computing this in `apply` (before the plugin `view().update`
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
       * @returns Whether the last doc change was a local user keystroke.
       */
      apply: (tr, value): boolean => {
        // A follow-up appended by another plugin's appendTransaction (e.g. the
        // caret whitespace normalizer) carries ProseMirror's internal
        // `appendedTransaction` meta. It rides WITH the root transaction that
        // triggered this update, so it must not overwrite the root's judgment —
        // otherwise a machine append after a remote edit would mask the remote
        // origin (the settled-state hole round 4 found).
        if (tr.getMeta('appendedTransaction')) return value;
        // Selection-only / no-op transactions carry no origin signal.
        if (!tr.docChanged) return value;
        // Remote peer edit OR local yUndo/redo: y-prosemirror tags the
        // transaction with the y-sync plugin key's meta, located by key NAME
        // 'y-sync$' — the duplicate-copy-safe lookup used across the collab
        // plugins. `tr.setMeta(ySyncPluginKey, …)` stores under the key's string
        // `.key`, so `getMeta('y-sync$')` reads it without importing the
        // transitive-dep instance. A yUndo is not a keystroke either — undo is
        // not an intent to open the picker — so, unlike the old discriminator,
        // it does not re-show a dismissed popup.
        const isRemoteOrUndo = tr.getMeta('y-sync$') !== undefined;
        // Machine-derived local dispatch (cascade-clear / chip display sync).
        const isMachine = tr.getMeta(MACHINE_EDIT_META) === true;
        return !isRemoteOrUndo && !isMachine;
      },
    },
  });
}

/**
 * Whether the LAST doc-changing transaction on the editor was a genuine LOCAL
 * USER keystroke (not a remote peer edit, a local yUndo, or a machine-derived
 * dispatch). The `@` suggestion uses it to drive popup visibility by local
 * intent only. Returns false when the tracker plugin is absent (a bare editor).
 * @param editor - The prompt editor.
 * @returns True when the last doc change was a local user keystroke.
 * @throws {never}
 */
export function wasLastChangeLocalUserInput(editor: Editor): boolean {
  return LOCAL_USER_INPUT_KEY.getState(editor.state) ?? false;
}

/**
 * Dispatches a MACHINE-DERIVED (non-user-typed) edit on the prompt editor,
 * applying BOTH machine-edit invariants in one place: keep it OUT of the
 * collaborative undo stack (addToHistory:false, so Cmd+Z reverts the user's own
 * edit rather than a machine cosmetic sync / edge-driven delete) AND tag it
 * MACHINE_EDIT_META so {@link wasLastChangeLocalUserInput} never counts it as a
 * keystroke (so it can never resurrect a dismissed `@` popup — #1802 round-4).
 * Every machine effect on the prompt (the edge-driven cascade-clear, the chip
 * display re-sync, and any future mini-tool write-back) must dispatch through
 * this so both invariants hold by construction rather than being re-derived and
 * drifting per call site.
 * @param view - The prompt editor view.
 * @param tr - The prepared transaction (its content already staged by the caller).
 * @throws {never}
 */
export function dispatchMachineEdit(view: EditorView, tr: Transaction): void {
  tr.setMeta('addToHistory', false);
  tr.setMeta(MACHINE_EDIT_META, true);
  view.dispatch(tr);
}
