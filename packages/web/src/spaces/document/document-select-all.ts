// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * rather than a text range on purpose: it is the one selection form whose
 * deletion is GUARANTEED to leave the document genuinely empty. A text range
 * sometimes does too — spanning all the text of two differently-shaped
 * blocks deletes to zero (`enter-across-blocks` pins it) — but over uniform
 * blocks it leaves a merged shell behind, and a tier that must arm the
 * whole-document guard cannot be built on a form whose outcome depends on
 * what the blocks happen to be. Empty is a legal state of this schema.
 *
 * ## The whole-document selection guards its own destruction
 *
 * The delete keys on an `AllSelection` do not delete. They ask, through
 * {@link DocumentSelectAllOptions.onClearDocumentRequest}, and the host shows
 * a confirmation dialog; `clearDocument` is what the dialog's confirm button
 * runs. The reason is measured, not stylistic: the undo stack lives in this
 * tab's memory, so a whole-document wipe followed by a closed tab is
 * unrecoverable until server-side savepoints ship — NN/g's confirmation
 * guideline ("actions with serious consequences — such as destroying users'
 * work") applies squarely. The interception is deliberately narrow: only the
 * whole-document tier asks; deleting a cross-block text selection is ordinary
 * editing and stays silent, and typing over — or cutting — the whole
 * selection stays silent too: both state their own intent, and both leave the
 * text recoverable (one undo, or a paste back from the clipboard).
 *
 * "The delete keys" means the whole chord family, not the two bare keys.
 * `@tiptap/core`'s Keymap extension routes Mod-Backspace, Shift-Backspace,
 * Mod-Delete — and on Apple platforms Ctrl-h, Alt-Backspace, Ctrl-d,
 * Ctrl-Alt-Backspace, Alt-Delete, Alt-d — each into its own deletion
 * command, so a guard bound to the bare names alone leaves every chord a
 * silent whole-document wipe (adversarial round 1; Ctrl-Backspace measured
 * doing exactly that). The chord list below mirrors the keymap's own,
 * platform split included; a non-whole-document selection answers false and
 * the chord falls through to the keymap binding it always had.
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

import { Extension, isMacOS, isiOS } from '@tiptap/core';
import {
  AllSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

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
 * Ask instead of deleting, for the whole-document tier only — the one guard
 * both input channels (key chords and `beforeinput`) funnel into.
 * @param state - The editor state at the input.
 * @param ask - The host's confirmation request, or null.
 * @returns True when the input was claimed; false lets it fall through.
 */
function guardWholeDocumentDelete(
  state: EditorState,
  ask: (() => void) | null,
): boolean {
  if (!isWholeDocumentSelection(state)) return false;
  if (state.doc.childCount === 0) return true;
  ask?.();
  return true;
}

/**
 * The deletion chords `@tiptap/core`'s Keymap extension binds on every
 * platform — copied from its `baseKeymap` definition, and pinned against the
 * installed dist by `delete-chords-mirror-kernel.test.ts`: a tiptap upgrade
 * that binds a new chord turns that guard red instead of silently reopening
 * an unguarded whole-document wipe.
 */
export const DELETE_CHORDS_BASE = [
  'Backspace',
  'Mod-Backspace',
  'Shift-Backspace',
  'Delete',
  'Mod-Delete',
] as const;

/** The chords the Keymap adds on Apple platforms, pinned the same way. */
export const DELETE_CHORDS_MAC = [
  'Ctrl-h',
  'Alt-Backspace',
  'Ctrl-d',
  'Ctrl-Alt-Backspace',
  'Alt-Delete',
  'Alt-d',
] as const;

/**
 * The `beforeinput` inputTypes that destroy the selection without stating
 * their own intent. Cut (`deleteByCut`) and drag (`deleteByDrag`) are
 * deliberately absent: cut leaves the content on the clipboard and drag
 * re-inserts it at the drop — both are the self-stating family the ruling
 * leaves unguarded, alongside typing over the selection.
 * @param inputType - The event's inputType.
 * @returns True for a bare destruction.
 */
function isBareDeletionInput(inputType: string): boolean {
  return (
    inputType.startsWith('delete') &&
    inputType !== 'deleteByCut' &&
    inputType !== 'deleteByDrag'
  );
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
          ({ state, tr, dispatch, editor }) => {
            // A whole-document write from a client that may not write: the
            // dialog can outlive a demotion to viewer, and the confirm would
            // otherwise wipe locally while the server drops the update — a
            // silent divergence (adversarial round 1).
            if (!editor.isEditable) return false;
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
     * The keyboard channel's binding into the shared guard.
     * @returns True when the key was claimed.
     */
    const guard = (): boolean =>
      guardWholeDocumentDelete(
        this.editor.state,
        this.options.onClearDocumentRequest,
      );

    // The same chord names, with the same platform split, that
    // `@tiptap/core`'s Keymap extension binds to its deletion commands.
    // This extension's higher priority makes these bindings run first; the
    // guard answers false off the whole-document tier and the chord falls
    // through to the keymap's own handler.
    const deleteChords = [
      ...DELETE_CHORDS_BASE,
      ...(isMacOS() || isiOS() ? DELETE_CHORDS_MAC : []),
    ];

    return {
      'Mod-a': () =>
        selectTier(this.editor.state, (tr) => this.editor.view.dispatch(tr)),
      ...Object.fromEntries(deleteChords.map((chord) => [chord, guard])),
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
      // The hard-break chords, swallowed on this tier and this tier only.
      // `@tiptap/extension-hard-break` binds both to `setHardBreak`, which
      // REPLACES the selection — over the whole document that is the entire
      // text traded for one break, a blank screen reached without a
      // confirmation. A hard break means "wrap inside this paragraph", and a
      // whole-document selection sits inside no paragraph: there is no
      // position to break, so nothing happens (user 2026-08-18). Every other
      // selection keeps the stock behaviour by answering false.
      'Shift-Enter': () => isWholeDocumentSelection(this.editor.state),
      'Mod-Enter': () => isWholeDocumentSelection(this.editor.state),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentSelectionNormaliser'),
        props: {
          handleDOMEvents: {
            /**
             * The keyboard is not deletion's only door. A browser menu
             * delete (macOS Edit → Delete, Firefox's context-menu Delete)
             * never fires keydown: the browser edits the DOM natively and
             * ProseMirror's DOMObserver reads the change back as an
             * ordinary transaction — desktop `prosemirror-view` handles
             * `beforeinput` for Android only. This is the layer those
             * doors share, and the same guard answers here.
             * @param view - The editor view.
             * @param event - The beforeinput event.
             * @returns True when claimed; the deletion is cancelled.
             */
            beforeinput: (view, event): boolean => {
              const { inputType } = event as InputEvent;
              if (!inputType || !isBareDeletionInput(inputType)) return false;
              // The guard decides — this channel does not re-derive the tier
              // for itself. Cancel only what it claimed, so an input it lets
              // through reaches the browser untouched.
              const claimed = guardWholeDocumentDelete(
                view.state,
                this.options.onClearDocumentRequest,
              );
              if (claimed) event.preventDefault();
              return claimed;
            },
          },
        },
        /**
         * Replace a `TextSelection` that resolved outside any textblock with
         * one the document can actually hold.
         *
         * An empty document gets the `AllSelection` — its only legal form. A
         * document WITH content gets the nearest valid caret instead: turning
         * a degenerate caret into a whole-document selection would flip
         * "nothing selected" into "everything selected", arming the guarded
         * delete for a keystroke nobody aimed at the whole document.
         * @param transactions - The transactions just applied.
         * @param oldState - The state before them.
         * @param newState - The state after them.
         * @returns The normalising transaction, or null.
         */
        appendTransaction(transactions, oldState, newState) {
          const { selection } = newState;
          // The resting AllSelection of an EMPTY document survives mapping —
          // an AllSelection covers the whole document by definition — so the
          // moment content arrives (a remote peer's paragraph, a programmatic
          // fill) it would silently widen into "everything selected", arming
          // the guarded delete for a selection nobody made. Collapse it to a
          // caret at the start instead.
          //
          // An undo restore is the one transition this must NOT touch: it
          // starts from zero blocks too, but the AllSelection it ends with is
          // the user's own — the selection they held before the confirmed
          // clear, put back by the undo machinery. Collapsing that swaps the
          // restored selection for a caret nobody placed (adversarial round
          // 1), so y-undo transactions pass through.
          const isUndoRedo = transactions.some((tr) => {
            const meta = tr.getMeta(ySyncPluginKey) as
              | { isUndoRedoOperation?: boolean }
              | undefined;
            return meta?.isUndoRedoOperation === true;
          });
          if (
            !isUndoRedo &&
            selection instanceof AllSelection &&
            oldState.doc.childCount === 0 &&
            newState.doc.childCount > 0
          ) {
            return newState.tr.setSelection(Selection.atStart(newState.doc));
          }
          if (!(selection instanceof TextSelection)) return null;
          if (selection.$from.parent.isTextblock) return null;
          if (newState.doc.childCount === 0) {
            return newState.tr.setSelection(new AllSelection(newState.doc));
          }
          return newState.tr.setSelection(Selection.near(selection.$from));
        },
      }),
    ];
  },
});
