// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What gets typed into the title stays text.
 *
 * The editor turns certain typed sequences into blocks: three dashes into a
 * divider, `# ` into a heading, `> ` into a quote, `- ` into a list. None of
 * those blocks can live in the title, whose content is text and nothing else.
 *
 * Most of those rules notice that for themselves and decline — they ask
 * whether the block can be wrapped or the type set, and produce no transaction
 * when the answer is no. The divider rule does not ask: it replaces the matched
 * text with a node the schema then refuses, and what remains of the
 * transaction is the deletion. Measured before this file existed: three dashes
 * at the start of the title left the title EMPTY, with the typed characters
 * gone and nothing in their place.
 *
 * This is written as a property of the title rather than as a fix to that one
 * rule. Which rules happen to check and which do not is a detail of the
 * editing feature set — a separate slice, still being built — and depending on
 * every future rule to check is exactly the kind of per-case dependence that
 * produced this bug. Here the title's own rule is stated once: text typed into
 * it is inserted as text, and nothing gets a chance to transform it.
 *
 * ## Two halves, because the rules have more than one way in
 *
 * `handleTextInput` is the door for typing, and claiming it first is the
 * editor's own mechanism — it is the hook the transforming rules listen on,
 * and the first handler to claim an input wins. The priority is what puts this
 * ahead of them: TipTap builds each extension's input rules into a plugin of
 * its own and orders the result by extension priority.
 *
 * That door is not the only one. TipTap's input-rule plugin also runs the
 * rules from `handleKeyDown` on Enter (as the text `"\n"`), from
 * `compositionend` after an input method commits, and from an `applyInputRules`
 * meta that `insertContent` can set. Measured: with only the typing door
 * claimed, `***` in the title followed by Enter left the title EMPTY and
 * swallowed the Enter, and the same text committed through an input method did
 * the same.
 *
 * Claiming each door in turn is not available and would be the wrong shape
 * anyway — returning true from `compositionend` would cancel the editor's own
 * composition handling, and a fourth door added upstream would arrive
 * unguarded. All four doors end in the same place: a transaction the rule
 * built, dispatched into the document. So the second half below rejects that
 * transaction rather than the doors, which is one statement about the title
 * instead of one per entry point.
 *
 * Enter needs one thing more, and it is not here: the rule plugin reports the
 * key as handled whether or not its transaction survives, so the title's own
 * Enter would be swallowed by a rule that achieved nothing. That is settled by
 * ordering, in `document-title` — the title's keys are decided before the
 * editing feature set is asked.
 *
 * ## The other half: a mark the caret's block refuses is not armed
 *
 * Formatting has a second entry point that no button guards — the keyboard.
 * `Mod-b` in the title runs the same command the toolbar does, and that command
 * arms the mark for the next keystroke without asking whether the block can
 * hold it. Measured: after one `Mod-b` in the title the bold button turns lit
 * AND pressed, while typing there produces unbolded text and pressing the
 * button changes nothing — the exact control R7 exists to prevent, arriving
 * through the door the button does not cover.
 *
 * The rule below is not about the title: a stored mark that the caret's block
 * refuses could never be applied by anyone, so it is not a stored mark. Stating
 * it that way covers the shortcut, the button, and any entry point added later,
 * rather than naming the three shortcuts that exist today.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DOCUMENT_TITLE_NODE } from '@breatic/shared';

/**
 * Keeps typed text in the title from being turned into anything else, and
 * keeps a mark its block refuses from being armed for the next keystroke.
 */
export const DocumentTitleIsPlainText = Extension.create({
  name: 'documentTitleIsPlainText',
  priority: 1000,

  /**
   * Claim text input that lands in the title and insert it verbatim.
   * @returns The plugin carrying that handler.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('documentTitleIsPlainText'),
        props: {
          handleTextInput: (view, from, _to, _text, deflt) => {
            if (
              view.state.doc.resolve(from).parent.type.name !==
              DOCUMENT_TITLE_NODE
            ) {
              return false;
            }
            // `deflt` is the transaction the editor would have applied had no
            // rule claimed this input — the editor's own insertion, marks and
            // selection handling included. Applying it is what makes this a
            // pass-through rather than a second implementation of typing.
            view.dispatch(deflt());
            return true;
          },
        },
        /**
         * Drop stored marks the caret's block cannot hold.
         * @param _transactions - The transactions just applied.
         * @param _oldState - The state before them.
         * @param newState - The state after them.
         * @returns A transaction dropping the refused marks, or null.
         */
        appendTransaction(_transactions, _oldState, newState) {
          const stored = newState.storedMarks;
          if (!stored || stored.length === 0) return null;
          const { parent } = newState.selection.$from;
          const kept = stored.filter((mark) =>
            parent.type.allowsMarkType(mark.type),
          );
          if (kept.length === stored.length) return null;
          // `null` rather than an empty list: an empty list means "explicitly
          // no marks", which is a state of its own, while `null` means nothing
          // is armed — which is the truth once the refused ones are gone.
          return newState.tr.setStoredMarks(kept.length > 0 ? kept : null);
        },

        /**
         * Refuse a transaction an input rule built, when it lands in the title.
         *
         * Recognised the way the editor recognises its own: the rule plugins
         * carry `isInputRules` on their spec and stamp each transaction they
         * dispatch with their own key — which is the pair TipTap's
         * `undoInputRule` reads to find the rule to undo. The stamp is on
         * every one of them; a rule can opt out of being undoable and none of
         * the rules this editor loads does.
         *
         * The state here is the one BEFORE the transaction, so the selection
         * read is where the caret was when the rule fired, which is where the
         * rule was going to act.
         * @param tr - The transaction awaiting application.
         * @param state - The state it would apply to.
         * @returns False to drop it.
         */
        filterTransaction(tr, state) {
          if (
            state.selection.$from.parent.type.name !== DOCUMENT_TITLE_NODE
          ) {
            return true;
          }
          return !state.plugins.some(
            (p) =>
              (p.spec as { isInputRules?: boolean }).isInputRules === true &&
              tr.getMeta(p) !== undefined,
          );
        },
      }),
    ];
  },
});
