// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What Enter does inside a quote.
 *
 * A quote is a prop on the block in this Space, not a container around it, so
 * every block BlockNote's Enter creates has to be told it is inside one.
 * BlockNote's handler tries four things in order, and two of them make a new
 * block:
 *
 * - An empty block with the caret at its start gets a fresh `paragraph`
 *   container built from `createAndFill()`, with no attributes at all.
 * - A non-empty block is split, with `keepProps` set to whether the caret sits
 *   at the block's start — so ending a line and pressing Enter passes
 *   `attrs: {}`.
 *
 * Either way the writer lands outside the quote they were writing in. This
 * handler takes over only for blocks that are inside a quote, and mirrors what
 * BlockNote would have done for each case, quote included. Everything else —
 * an unquoted block, a hard break, lifting an empty indented block out a level
 * — falls straight through.
 */

import { createExtension, getBlockInfoFromSelection } from '@blocknote/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';

import {
  QUOTED,
  splitCarryingQuote,
  type ListEditor,
} from '@web/spaces/document/document-list-block';

/**
 * The three block types that answer Enter with a handler of their own.
 *
 * Each of them registers that handler with the block, and a block's keymap is
 * reached before the one this file adds — so by the time Enter arrives here
 * over a list item, that handler has already declined it.
 */
const LIST_ITEM_TYPES = [
  'numberedListItem',
  'bulletListItem',
  'checkListItem',
] as const;

/**
 * Opens a new quoted paragraph after an empty quoted block.
 *
 * Mirrors BlockNote's own "empty block, caret at start" case, which builds the
 * container with `createAndFill()` and so gives it no attributes.
 * @param tr - The transaction to write into.
 * @param afterPos - Where the current block ends.
 * @param childContainer - The current block's children, to carry over.
 * @returns Whether the block was opened.
 */
function openQuotedBlockAfter(
  tr: Transaction,
  afterPos: number,
  childContainer: { node: unknown; beforePos: number; afterPos: number } | undefined,
): boolean {
  const { schema } = tr.doc.type;
  const paragraph = schema.nodes['paragraph']?.createAndFill({
    [QUOTED]: true,
  });
  if (paragraph === undefined || paragraph === null) {
    return false;
  }
  const container = schema.nodes['blockContainer']?.createAndFill(
    undefined,
    [paragraph, childContainer?.node].filter((node) => node !== undefined) as never,
  );
  if (container === undefined || container === null) {
    return false;
  }
  tr.insert(afterPos, container)
    .setSelection(new TextSelection(tr.doc.resolve(afterPos + 2)))
    .scrollIntoView();
  if (childContainer !== undefined) {
    tr.delete(childContainer.beforePos, childContainer.afterPos);
  }
  return true;
}

/**
 * Enter, for a block that sits inside a quote.
 * @param editor - The editor Enter was pressed in.
 * @returns Whether this handler claimed the key.
 */
function handleQuotedEnter(editor: ListEditor): boolean {
  return editor.transact((tr) => {
    const info = getBlockInfoFromSelection(tr);
    if (!info.isBlockContainer) {
      return false;
    }
    const { blockContent, bnBlock, childContainer } = info;
    const type = blockContent.node.type.name;

    if (LIST_ITEM_TYPES.some((listType) => listType === type)) {
      // A list item's own handler has already had this key and declined it,
      // and the quote is one of the things it carries across itself.
      return false;
    }
    if (blockContent.node.attrs[QUOTED] !== true) {
      return false;
    }

    const atBlockStart = tr.selection.$from.parentOffset === 0;
    // Both of the reads below are about the block the selection OPENS in, and
    // both stay true once it runs past that block. The empty branch answers by
    // opening a block rather than replacing anything, so a selection reaching
    // it would leave what the reader highlighted where it was.
    const blockEmpty = tr.selection.empty && blockContent.node.childCount === 0;
    const indented = tr.doc.resolve(bnBlock.beforePos).depth > 1;

    if (blockEmpty) {
      if (atBlockStart && indented) {
        // BlockNote lifts this one out a level, which creates no block and so
        // loses no props.
        return false;
      }
      return atBlockStart
        ? openQuotedBlockAfter(tr, bnBlock.afterPos, childContainer)
        : false;
    }

    tr.deleteSelection();
    tr.scrollIntoView();
    return splitCarryingQuote(tr, tr.selection.from, atBlockStart, atBlockStart);
  });
}

/**
 * Opens an empty paragraph block at a position, with the caret inside it.
 *
 * The two selections below both want this and neither can ask BlockNote for
 * it: what goes in is a `blockContainer`, which is the only thing a
 * `blockGroup` accepts, and the caret lands two positions in — past the
 * container and past the paragraph.
 * @param tr - The transaction to write into.
 * @param at - Where the new block goes.
 */
function openBlockAt(tr: Transaction, at: number): void {
  const paragraph = tr.doc.type.schema.nodes['paragraph'];
  const container = tr.doc.type.schema.nodes['blockContainer'];
  if (!paragraph || !container) {
    return;
  }
  tr.insert(at, container.create(null, paragraph.create()));
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  tr.scrollIntoView();
}

/**
 * Enter with the whole document selected.
 *
 * What it gets is somewhere to write at the end, with the caret in it, and the
 * text untouched — Enter is not a request to replace the document.
 *
 * Answered before anything else looks at the key because BlockNote's own
 * `splitBlock` raises on this selection: `splitBlock.ts:55` hands the
 * selection straight to `tr.split`, and a whole-document selection resolves
 * outside every block, so `prosemirror-transform` reads `copy` off an
 * undefined parent. That throw reaches the keydown handler.
 * @param editor - The editor Enter was pressed in.
 * @returns True, having handled the key.
 */
function handleWholeDocumentEnter(editor: ListEditor): boolean {
  editor.transact((tr) => {
    openBlockAt(tr, tr.doc.content.size - 1);
  });
  return true;
}

/**
 * Enter with one whole block selected.
 *
 * A reader reaches this by holding the platform's select-node modifier over a
 * block, and what Enter gets them is a new block after that one — the block
 * they selected untouched, which is what every editor with a block handle
 * does.
 *
 * Answered here because BlockNote's own answer raises:
 * `NodeSelectionKeyboard.ts:48` inserts a bare `paragraph`, which a
 * `blockGroup` does not accept, at `$to.after() + 1`, which for a document
 * whose only block is selected is one position past its end.
 * @param editor - The editor Enter was pressed in.
 * @returns True, having handled the key.
 */
function handleWholeBlockEnter(editor: ListEditor): boolean {
  editor.transact((tr) => {
    openBlockAt(tr, tr.selection.to);
  });
  return true;
}

/**
 * The extension that binds Enter for the whole document.
 *
 * Reached after the block's own keymap, which the three list types register
 * their handler with. What this file answers is what no block can: the two
 * selection kinds that are not resolved inside any block, and the quote,
 * which is a prop rather than a block type.
 */
export const documentEnterExtension = createExtension(() => ({
  key: 'document-enter',
  keyboardShortcuts: {
    Enter: ({ editor }: { editor: ListEditor }) => {
      const { selection } = editor.prosemirrorState;
      if (selection instanceof AllSelection) {
        return handleWholeDocumentEnter(editor);
      }
      if (selection instanceof NodeSelection) {
        return handleWholeBlockEnter(editor);
      }
      return handleQuotedEnter(editor);
    },
  },
}) as never);
