// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Select-all in two tiers, and the guard on deleting the whole document.
 *
 * The undo stack lives in this tab's memory only. A keystroke that empties the
 * document is one nobody else can put back, and the client that pressed it
 * loses the stack the moment the tab closes — so on that one tier the key asks
 * instead of deleting. Every other selection keeps the stock behaviour.
 *
 * Two channels reach a deletion and both funnel into one guard: the chords
 * tiptap's keymap binds, which is still underneath BlockNote, and
 * `beforeinput`, which is how a browser's Edit menu deletes without ever
 * firing a keydown — desktop `prosemirror-view` handles that event for Android
 * only.
 *
 * Clearing leaves ONE EMPTY PARAGRAPH. BlockNote's schema is
 * `doc > blockGroup > blockGroupChild+` (`BlockGroup.ts:11`), so a document
 * with no blocks is not a state this editor can rest in.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import {
  AllSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import { isMacOS, isiOS } from '@tiptap/core';
import { ySyncPluginKey } from 'y-prosemirror';

/** What this file needs of the editor object. */
export interface SelectAllEditor {
  readonly isEditable: boolean;
  transact: <T>(run: (tr: Transaction) => T) => T;
}

/**
 * The deletion chords `@tiptap/core`'s Keymap extension binds on every
 * platform — copied from its `baseKeymap` definition, and pinned against the
 * installed dist by `delete-chords-mirror-kernel.test.ts`: an upgrade that
 * binds a new chord turns that guard red instead of silently reopening an
 * unguarded whole-document wipe.
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
 * Whether a selection is the whole-document form the guarded keys act on.
 * @param selection - The selection to judge.
 * @returns True for an `AllSelection`.
 */
export function isWholeDocumentSelection(selection: Selection): boolean {
  return selection instanceof AllSelection;
}

/**
 * Asks instead of deleting, for the whole-document tier only.
 * @param selection - The selection at the input.
 * @param ask - The host's confirmation request, or null.
 * @returns True when the input was claimed; false lets it fall through.
 */
function guardWholeDocumentDelete(
  selection: Selection,
  ask: (() => void) | null,
): boolean {
  if (!isWholeDocumentSelection(selection)) {
    return false;
  }
  ask?.();
  return true;
}

/**
 * The `beforeinput` inputTypes that destroy the selection without stating
 * their own intent. Cut and drag are deliberately absent: cut leaves the
 * content on the clipboard and drag re-inserts it at the drop, so both are the
 * self-stating family the ruling leaves unguarded, alongside typing over the
 * selection.
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
 * Answers one press of `Mod-a` with the tier the current selection asks for.
 *
 * The "current block" of the first tier is the innermost textblock holding the
 * caret — a paragraph inside a list item is that paragraph, not the item.
 * @param tr - The transaction to select in.
 * @returns Always true; the binding owns the key on every path.
 */
function selectTier(tr: Transaction): boolean {
  const { selection, doc } = tr;
  // Already at the top tier: stay there.
  if (selection instanceof AllSelection) {
    return true;
  }
  // Only a caret or a range inside ONE textblock gets the first tier —
  // everything else has already outgrown "the current block".
  if (selection instanceof TextSelection) {
    const { $from, $to } = selection;
    if ($from.sameParent($to) && $from.parent.isTextblock) {
      const from = $from.start();
      const to = $from.end();
      if (selection.from !== from || selection.to !== to) {
        tr.setSelection(TextSelection.create(doc, from, to));
        return true;
      }
    }
  }
  tr.setSelection(new AllSelection(doc));
  return true;
}

/**
 * Replaces everything with one empty paragraph.
 *
 * Refused on an editor this client may not write to: the confirmation dialog
 * can outlive a demotion to viewer, and confirming would otherwise wipe
 * locally while the server drops the update — a silent divergence.
 * @param editor - The editor to clear.
 * @returns Whether anything was written.
 */
export function clearDocument(editor: SelectAllEditor): boolean {
  if (!editor.isEditable) {
    return false;
  }
  return editor.transact((tr) => {
    const paragraph = tr.doc.type.schema.nodes['paragraph'];
    const container = tr.doc.type.schema.nodes['blockContainer'];
    const group = tr.doc.type.schema.nodes['blockGroup'];
    if (!paragraph || !container || !group) {
      return false;
    }
    tr.replaceWith(
      0,
      tr.doc.content.size,
      group.create(null, container.create(null, paragraph.create())),
    );
    tr.setSelection(Selection.atStart(tr.doc));
    tr.scrollIntoView();
    return true;
  });
}

/**
 * The plugin behind the two non-keyboard halves: the browser's own delete, and
 * putting right a selection the document cannot hold.
 * @param ask - The host's confirmation request, or null.
 * @returns The ProseMirror plugin.
 */
function guardPlugin(ask: (() => void) | null): Plugin {
  return new Plugin({
    key: new PluginKey('documentSelectionGuard'),
    props: {
      handleDOMEvents: {
        /**
         * The keyboard is not deletion's only door. A browser menu delete
         * never fires keydown: the browser edits the DOM natively and
         * ProseMirror reads the change back as an ordinary transaction.
         * @param view - The editor view.
         * @param event - The beforeinput event.
         * @returns True when claimed; the deletion is cancelled.
         */
        beforeinput: (view, event): boolean => {
          const { inputType } = event as InputEvent;
          if (!inputType || !isBareDeletionInput(inputType)) {
            return false;
          }
          const claimed = guardWholeDocumentDelete(view.state.selection, ask);
          if (claimed) {
            event.preventDefault();
          }
          return claimed;
        },
      },
    },

    /**
     * Replaces a `TextSelection` that resolved outside any textblock with one
     * the document can hold.
     *
     * The nearest valid caret, never the whole document: widening a degenerate
     * caret into an `AllSelection` would flip "nothing selected" into
     * "everything selected", arming the guarded delete for a keystroke nobody
     * aimed at the whole document.
     *
     * An undo restore passes through untouched — the `AllSelection` it ends
     * with is the user's own, put back by the undo machinery.
     * @param transactions - The transactions just applied.
     * @param _oldState - The state before them.
     * @param newState - The state after them.
     * @returns The normalising transaction, or null.
     */
    appendTransaction(transactions, _oldState, newState) {
      const isUndoRedo = transactions.some((tr) => {
        const meta = tr.getMeta(ySyncPluginKey) as
          | { isUndoRedoOperation?: boolean }
          | undefined;
        return meta?.isUndoRedoOperation === true;
      });
      if (isUndoRedo) {
        return null;
      }
      const { selection } = newState;
      if (!(selection instanceof TextSelection)) {
        return null;
      }
      if (selection.$from.parent.isTextblock) {
        return null;
      }
      return newState.tr.setSelection(Selection.near(selection.$from));
    },
  });
}

/**
 * The extension that binds the tiers, the guarded keys and the plugin.
 * @param ask - Called instead of deleting when a delete lands on a
 *   whole-document selection. Null swallows the keystroke: absence of a
 *   handler must not mean deletion.
 * @returns The extension, for the assembly to register.
 */
export function documentSelectAllExtension(
  ask: (() => void) | null,
): ExtensionFactoryInstance {
  const chords = [
    ...DELETE_CHORDS_BASE,
    ...(isMacOS() || isiOS() ? DELETE_CHORDS_MAC : []),
  ];

  return createExtension(({ editor }: { editor: SelectAllEditor }) => ({
    key: 'documentSelectAll',
    // Ahead of the code block's own deletion keys. Those ask whether the
    // caret's block is empty and of their type, both of which a whole
    // document selection satisfies when the one block is an empty code
    // block — and answering there skips the confirmation this guard owes.
    runsBefore: ['code-block-keyboard-shortcuts'],
    keyboardShortcuts: {
      'Mod-a': () => editor.transact(selectTier),
      ...Object.fromEntries(
        chords.map((chord) => [
          chord,
          () =>
            editor.transact((tr) =>
              guardWholeDocumentDelete(tr.selection, ask),
            ),
        ]),
      ),
    },
    prosemirrorPlugins: [guardPlugin(ask)],
  }) as never)();
}
