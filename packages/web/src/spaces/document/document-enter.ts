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

import {
  createExtension,
  getBlockInfo,
  getBlockInfoAtNearest,
  getNearestBlockPos,
} from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';

import {
  QUOTED,
  splitCarryingQuote,
  type ListEditor,
} from '@web/spaces/document/document-list-block';

/**
 * The four block types that answer Enter with a handler of their own.
 *
 * Each registers that handler with the block, and this file's binding runs
 * FIRST — measured, `document-enter` sits at priority 111 against their 101,
 * and tiptap runs the higher number first. So reaching them is what declining
 * here is for: claim one of these and the block's own answer never happens.
 * The three list items split and carry their kind across; a code block takes
 * a newline inside itself.
 */
const OWN_ENTER_TYPES = [
  'numberedListItem',
  'bulletListItem',
  'checkListItem',
  'codeBlock',
] as const;

/**
 * Enter, for a block that sits inside a quote.
 * @param editor - The editor Enter was pressed in.
 * @returns Whether this handler claimed the key.
 */
function handleQuotedEnter(editor: ListEditor): boolean {
  return editor.transact((tr) => {
    // Read at `from`, the end of the selection the cut falls on. Asking the
    // selection instead reads its ANCHOR — the end the drag started at — so
    // the same highlight named a different block depending on which way it
    // was drawn, and the quote test below answered for the wrong one.
    const info = getBlockInfoAtNearest(tr, tr.selection.from);
    if (!info.isBlockContainer) {
      return false;
    }
    const { blockContent, bnBlock, childContainer } = info;
    const type = blockContent.node.type.name;

    if (OWN_ENTER_TYPES.some((ownType) => ownType === type)) {
      // These answer Enter themselves and this file runs first, so declining
      // is what lets them. Measured priorities: `document-enter` 111, the
      // three list extensions and `code-block-keyboard-shortcuts` 101, and
      // tiptap runs the higher number first. The quote is a prop on the block,
      // so it rides along whatever they do — a list item carries it across a
      // split, and a code block takes a newline without splitting at all.
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
      // Every node that declares `quoted` is a textblock, so an empty one
      // puts the caret at offset 0. `blocknote-schema.test.ts` holds that.
      if (indented) {
        // BlockNote lifts this one out a level, which creates no block and so
        // loses no props.
        return false;
      }
      if (
        !openBlockAt(
          tr,
          bnBlock.afterPos,
          { [QUOTED]: true },
          childContainer?.node,
        )
      ) {
        return false;
      }
      // The children went in beside the new paragraph rather than moving, so
      // the originals go now. Mirrors what BlockNote does for this case.
      if (childContainer !== undefined) {
        tr.delete(childContainer.beforePos, childContainer.afterPos);
      }
      return true;
    }

    tr.deleteSelection();
    tr.scrollIntoView();
    return splitCarryingQuote(tr, tr.selection.from, atBlockStart, atBlockStart);
  });
}

/**
 * Opens an empty paragraph block at a position, with the caret inside it.
 *
 * All three paths into a new block want this and none can ask BlockNote for
 * it: what goes in is a `blockContainer`, which is the only thing a
 * `blockGroup` accepts, and the caret lands two positions in — past the
 * container and past the paragraph.
 * @param tr - The transaction to write into.
 * @param at - Where the new block goes.
 * @param attrs - What to build the paragraph with. Left out, the schema's
 *   defaults apply, and `quoted` defaults to false.
 * @param child - The block group to put under the new block, for the caller
 *   that is moving one over. It is inserted alongside the paragraph rather
 *   than moved, so that caller deletes the original itself.
 * @returns Whether the block was opened. Only a schema without these two
 *   nodes answers no, and the callers that can decline hand the key on.
 */
function openBlockAt(
  tr: Transaction,
  at: number,
  attrs?: Record<string, unknown>,
  child?: PMNode,
): boolean {
  const paragraph = tr.doc.type.schema.nodes['paragraph'];
  const container = tr.doc.type.schema.nodes['blockContainer'];
  if (!paragraph || !container) {
    return false;
  }
  const content = [paragraph.create(attrs), child].filter(
    (node): node is PMNode => node !== undefined,
  );
  tr.insert(at, container.create(null, content));
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  tr.scrollIntoView();
  return true;
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
 * `NodeSelectionKeyboard.ts:52` inserts a bare `paragraph`, which a
 * `blockGroup` does not accept.
 *
 * The new block goes after the whole CONTAINER. The gesture selects the
 * content node — measured in a browser, `Cmd`-clicking a paragraph leaves
 * `.ProseMirror-selectednode` on `div.bn-block-content` — and a container
 * holds `blockContent blockGroup?`, so the position after that node is
 * inside the container whenever anything is indented under the block.
 * Opening a block there splits the container and the indented blocks move
 * out from under their parent.
 * @param editor - The editor Enter was pressed in.
 * @returns True, having handled the key.
 */
function handleWholeBlockEnter(editor: ListEditor): boolean {
  editor.transact((tr) => {
    const info = getBlockInfo(getNearestBlockPos(tr.doc, tr.selection.from));
    if (!info.isBlockContainer) {
      return;
    }
    // The quote rides across, the way it does on every other path into a new
    // block (A7b). It is a prop on each block here, so a block built from the
    // schema's defaults opens outside the quote and cuts the run in two.
    openBlockAt(tr, info.bnBlock.afterPos, {
      [QUOTED]: info.blockContent.node.attrs[QUOTED],
    });
  });
  return true;
}

/**
 * The extension that binds Enter for the whole document.
 *
 * Runs BEFORE the handlers the blocks register, so what it declines is what
 * reaches them. What it answers is what no block can: the two selection kinds
 * that are not resolved inside any block, and the quote, which is a prop
 * rather than a block type.
 */
export const documentEnterExtension = createExtension(() => ({
  key: 'document-enter',
  // Ahead of the code block's own Enter, which asks only what type the
  // caret's block is and answers with `insertText`. Over a node selection
  // that replaces the whole block, so the two selection kinds this file
  // answers for never reached it.
  runsBefore: ['code-block-keyboard-shortcuts'],
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
