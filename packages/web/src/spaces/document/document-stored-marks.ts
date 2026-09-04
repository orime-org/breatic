// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Keeps the formatting a writer chose from being swept away by bookkeeping.
 *
 * `storedMarks` is where ProseMirror holds "what the next character typed
 * here will carry" — set by pressing `Mod-b` with no selection, and set again
 * by the two split paths so that ending a bold line and pressing Enter leaves
 * the writer still bold.
 *
 * `Transaction.addStep` clears it, unconditionally, which is right on its own
 * terms: the document just changed under those marks. What makes it wrong here
 * is WHICH transaction changes the document next. BlockNote gives every block
 * an id, and `UniqueID.ts:149` appends a transaction to write ids onto blocks
 * a change just created — a split creates one every time. That transaction
 * carries a step, the step clears the marks, and the writer's choice is gone
 * before a single character is typed.
 *
 * So the marks are put back once the round of appended transactions is over.
 * The condition is narrow on purpose: a transaction the USER dispatched said
 * what the marks should be, and the state no longer has them. Typing does not
 * match it (`insertText` carries a step, so its own `storedMarks` is already
 * null), nor does a remote update, nor moving the caret.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { createExtension } from '@blocknote/core';

/**
 * The plugin that restores them.
 *
 * ProseMirror calls every plugin's `appendTransaction` again whenever one of
 * them appends, so this runs after the id-writing pass rather than before it.
 * The transaction it returns carries no step, which is what lets the marks
 * survive it.
 * @returns The plugin.
 */
function storedMarksPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('documentStoredMarks'),
    appendTransaction: (transactions, _oldState, newState) => {
      if (newState.storedMarks !== null) {
        return null;
      }
      const wanted = transactions.find(
        (transaction) =>
          transaction.storedMarks !== null &&
          transaction.getMeta('appendedTransaction') === undefined,
      )?.storedMarks;
      if (wanted === undefined || wanted === null || wanted.length === 0) {
        return null;
      }
      return newState.tr.setStoredMarks(wanted);
    },
  });
}

/** The extension that registers it. */
export const documentStoredMarksExtension = createExtension(() => ({
  key: 'documentStoredMarks',
  prosemirrorPlugins: [storedMarksPlugin()],
}) as never);
