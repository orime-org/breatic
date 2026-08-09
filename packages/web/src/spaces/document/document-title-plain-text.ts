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
 * ## Why a plugin, and why the priority
 *
 * `handleTextInput` is the editor's own hook for this — it is the hook the
 * transforming rules themselves listen on, and the first handler to claim an
 * input wins. So claiming it first is not a workaround; it is the mechanism.
 *
 * The priority is what puts this first. TipTap builds each extension's input
 * rules into a plugin of its own and orders the result by extension priority,
 * so without one this would sit behind StarterKit's rules and never be asked.
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
      }),
    ];
  },
});
