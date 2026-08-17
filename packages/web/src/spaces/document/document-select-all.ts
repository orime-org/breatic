// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document's select-all tiers, and what the keys do to a whole-document
 * selection.
 *
 * The behaviour table is a ruling, not a convention: the transition tables in
 * the document structure decision record (2026-08-17, private engineering
 * repo) define every cell, and this file only carries them out.
 *
 * ## Two tiers of `Mod-a`
 *
 * A caret or a partial selection inside one textblock selects that block's
 * text first; a second press — or any selection that already reaches past one
 * block — selects the whole document as an `AllSelection`. `AllSelection`
 * rather than a text range on purpose: it is the only selection form whose
 * deletion leaves the document genuinely empty (a text range leaves a merged
 * shell block behind), and empty is a legal state of this schema.
 *
 * ## The whole-document selection guards its own destruction
 *
 * Backspace and Delete on an `AllSelection` do not delete. They ask, through
 * {@link DocumentSelectAllOptions.onClearDocumentRequest}, and the host shows
 * a confirmation dialog; `clearDocument` is what the dialog's confirm button
 * runs. The reason is measured, not stylistic: the undo stack lives in this
 * tab's memory, so a whole-document wipe followed by a closed tab is
 * unrecoverable until server-side savepoints ship — NN/g's confirmation
 * guideline ("actions with serious consequences — such as destroying users'
 * work") applies squarely. The interception is deliberately narrow: only the
 * whole-document tier asks; deleting a cross-block text selection is ordinary
 * editing and stays silent, and typing over the whole selection stays silent
 * too — typing is itself the statement of intent, and one undo brings the
 * text back.
 *
 * When no handler is wired (schema-only builders, tests that do not care),
 * the keystroke does nothing rather than falling through to deletion: a
 * missing dialog must never widen into a silent wipe.
 *
 * Enter on the whole-document selection creates instead of destroying: the
 * content stays, an empty paragraph lands at the end and the caret moves into
 * it. Anything else would make Enter a second, unguarded wipe path —
 * deliberately diverging from the editor convention of replacing a selection,
 * for this one selection form only.
 *
 * ## The degenerate-selection guard
 *
 * A document with no blocks has no text position, so anything that restores a
 * stored `TextSelection` into it — a remote update racing a local selection,
 * an undo stack popped dry — ends up with a selection pointing at the doc
 * node itself. Measured while probing for the structure decision: ProseMirror
 * warns and limps along. The plugin below normalises that shape to an
 * `AllSelection`, which is the one selection an empty document can hold.
 */

import { Extension } from '@tiptap/core';
import {
  AllSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    documentSelectAll: {
      /**
       * Empty the document — the confirm button's half of the guarded
       * whole-document delete.
       */
      clearDocument: () => ReturnType;
    };
  }
}

/** What the host wires into the select-all tiers. */
export interface DocumentSelectAllOptions {
  /**
   * Called instead of deleting when Backspace or Delete lands on a
   * whole-document selection. The host confirms with the user and runs
   * `clearDocument` on yes. Null swallows the keystroke — see the header for
   * why absence must not mean deletion.
   */
  onClearDocumentRequest: (() => void) | null;
}

/**
 * Whether the selection is the whole-document form the guarded keys act on.
 * @param state - The editor state to read.
 * @returns True for an `AllSelection`.
 */
function isWholeDocumentSelection(state: EditorState): boolean {
  return state.selection instanceof AllSelection;
}

/**
 * Select the whole document.
 * @param state - The state to select in.
 * @param dispatch - The view's dispatch.
 * @returns Always true — the key is answered even when nothing changed.
 */
function selectWholeDocument(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
): boolean {
  dispatch(state.tr.setSelection(new AllSelection(state.doc)));
  return true;
}

/**
 * Answer one press of `Mod-a` with the tier the current selection asks for.
 *
 * The "current block" of the first tier is the innermost textblock holding
 * the caret — a paragraph inside a list item is that paragraph, not the item.
 * @param state - The editor state at the press.
 * @param dispatch - The view's dispatch.
 * @returns Always true; the binding owns the key on every path.
 */
function selectTier(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
): boolean {
  // An empty document has nothing to select at either tier.
  if (state.doc.childCount === 0) return true;
  const { selection } = state;
  // Already at the top tier: stay there.
  if (selection instanceof AllSelection) return true;
  // Only a caret or a range inside ONE textblock gets the first tier —
  // everything else (a node selection, a gap cursor, a range that crosses
  // blocks) has already outgrown "the current block".
  if (selection instanceof TextSelection) {
    const { $from, $to } = selection;
    if ($from.sameParent($to) && $from.parent.isTextblock) {
      const from = $from.start();
      const to = $from.end();
      const alreadyWholeBlock = selection.from === from && selection.to === to;
      if (!alreadyWholeBlock) {
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
        return true;
      }
    }
  }
  return selectWholeDocument(state, dispatch);
}

/**
 * The select-all tiers, the guarded whole-document keys, and the
 * degenerate-selection guard. Priority above `@tiptap/core`'s own keymap so
 * `Mod-a` is answered here, not by the stock select-all.
 */
export const DocumentSelectAll = Extension.create<DocumentSelectAllOptions>({
  name: 'documentSelectAll',
  priority: 1000,

  addOptions() {
    return { onClearDocumentRequest: null };
  },

  addCommands() {
    return {
      clearDocument:
        () =>
          ({ state, tr, dispatch }) => {
            if (state.doc.childCount === 0) return false;
            if (dispatch) {
              tr.delete(0, state.doc.content.size);
              tr.setSelection(new AllSelection(tr.doc));
              tr.scrollIntoView();
            }
            return true;
          },
    };
  },

  addKeyboardShortcuts() {
    /**
     * Ask the host to confirm instead of deleting, for the whole-document
     * tier only.
     * @returns True when the key was claimed.
     */
    const guardWholeDocumentDelete = (): boolean => {
      const { state } = this.editor;
      if (!isWholeDocumentSelection(state)) return false;
      if (state.doc.childCount === 0) return true;
      this.options.onClearDocumentRequest?.();
      return true;
    };

    return {
      'Mod-a': () =>
        selectTier(this.editor.state, (tr) => this.editor.view.dispatch(tr)),
      Backspace: guardWholeDocumentDelete,
      Delete: guardWholeDocumentDelete,
      Enter: () => {
        const { state } = this.editor;
        if (!isWholeDocumentSelection(state)) return false;
        if (state.doc.childCount === 0) return true;
        const paragraph = state.schema.nodes['paragraph'];
        if (!paragraph) return false;
        const tr = state.tr.insert(state.doc.content.size, paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
        this.editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentSelectionNormaliser'),
        /**
         * Replace a `TextSelection` that resolved outside any textblock with
         * the `AllSelection` an empty document can actually hold.
         * @param _transactions - The transactions just applied.
         * @param _oldState - The state before them.
         * @param newState - The state after them.
         * @returns The normalising transaction, or null.
         */
        appendTransaction(_transactions, _oldState, newState) {
          const { selection } = newState;
          if (!(selection instanceof TextSelection)) return null;
          if (selection.$from.parent.isTextblock) return null;
          return newState.tr.setSelection(new AllSelection(newState.doc));
        },
      }),
    ];
  },
});
