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
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';

import {
  QUOTED,
  splitCarryingQuote,
  type ListEditor,
} from '@web/spaces/document/document-list-block';

/** What the editor object offers the Tab handler. */
interface TabEditor {
  nestBlock: () => void;
  unnestBlock: () => void;
}

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
      return openQuotedBlockAfter(tr, bnBlock.afterPos, childContainer);
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
 * @param attrs - What to build the paragraph with. Left out, the schema's
 *   defaults apply, and `quoted` defaults to false.
 */
function openBlockAt(
  tr: Transaction,
  at: number,
  attrs?: Record<string, unknown>,
): void {
  const paragraph = tr.doc.type.schema.nodes['paragraph'];
  const container = tr.doc.type.schema.nodes['blockContainer'];
  if (!paragraph || !container) {
    return;
  }
  tr.insert(at, container.create(null, paragraph.create(attrs)));
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
 * Reached after the block's own keymap, which the three list types register
 * their handler with. What this file answers is what no block can: the two
 * selection kinds that are not resolved inside any block, and the quote,
 * which is a prop rather than a block type.
 */
/**
 * Tab and Shift-Tab, for every selection rather than for a caret alone.
 *
 * The move and the question of whether it is possible are the same call:
 * `nestBlock` reads `$from.blockRange($to)` and leaves the document alone when
 * the range has nowhere to go (`nestBlock.ts`, `startIndex === 0`). Asking a
 * separate question first is what put the two out of step — `canNestBlock`
 * resolves the block at `selection.anchor`, which is the end the drag started
 * from, so a backwards drag asked about one block and acted on another.
 *
 * The key is claimed either way. An unclaimed Tab is one the browser answers,
 * and the browser answers it by moving focus out of the editor: measured,
 * focus went from the editor to `BODY` and the next characters the reader
 * typed reached nothing. BlockNote's own source says the same —
 * `KeyboardShortcutsExtension.ts:958`, "Always returning true for tab key
 * presses ensures they're not captured by the browser. Otherwise, they blur
 * the editor".
 */
export const documentTabExtension = createExtension(() => ({
  key: 'document-tab',
  keyboardShortcuts: {
    Tab: ({ editor }: { editor: TabEditor }) => {
      editor.nestBlock();
      return true;
    },
    'Shift-Tab': ({ editor }: { editor: TabEditor }) => {
      editor.unnestBlock();
      return true;
    },
  },
}) as never);

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
