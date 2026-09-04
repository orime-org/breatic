// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What Enter does, for every shape of selection it can be pressed on.
 *
 * Splitting a block is decided in this Space rather than by BlockNote, because
 * two things a writer expects to survive a split do not survive BlockNote's:
 *
 * - **The quote.** It is a prop on the block here, not a container around it,
 *   so a block split off from a quoted one carries the quote only if someone
 *   puts it there. `splitBlockTr` passes `attrs: {}` unless the caret sits at
 *   the block's start, which drops the writer out of the quote they were in.
 * - **The formatting.** `tr.split` clears the stored marks, and BlockNote's
 *   split does not put them back. Neither can we, afterwards: `splitBlockTr`
 *   lives inside the published bundle, and marks restored around it are
 *   cleared again by the id-writing pass that always follows a split.
 *
 * Three handlers cover the shapes between them — the list handlers in
 * `document-list-block.ts` for the three list types, `handleProseEnter` for
 * everything else, and one each for the two selections BlockNote raises on.
 * What still falls through to BlockNote is Enter on an EMPTY block, where its
 * own rules (lift out a level, leave the list) create nothing and so lose
 * nothing.
 */

import { createExtension, getBlockInfoFromSelection } from '@blocknote/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';

import {
  handleListEnter,
  QUOTED,
  splitCarryingQuote,
  type ListEditor,
} from '@web/spaces/document/document-list-block';

/** The three block types that answer Enter with a list handler of their own. */
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
 * Enter, for prose — every block that is not a list item.
 *
 * Splitting a block is decided here for all three kinds this Space has: the
 * list handlers below for the three list types, and this one for everything
 * else. What BlockNote's own split leaves behind is a block that has lost the
 * quote it was in and the formatting the writer had chosen, and neither can be
 * put back afterwards: its `splitBlockTr` is inside the published bundle, and
 * the marks it drops are cleared again by the id-writing pass that follows.
 *
 * An EMPTY block still falls through to BlockNote, which answers Enter there
 * by lifting the block out a level or leaving the list — its own rules, and
 * nothing is split, so nothing is lost.
 * @param editor - The editor Enter was pressed in.
 * @returns Whether this handler claimed the key.
 */
function handleProseEnter(editor: ListEditor): boolean {
  return editor.transact((tr) => {
    const info = getBlockInfoFromSelection(tr);
    if (!info.isBlockContainer) {
      return false;
    }
    const { blockContent, bnBlock, childContainer } = info;
    const type = blockContent.node.type.name;

    if (LIST_ITEM_TYPES.some((listType) => listType === type)) {
      // The list handlers already carry the quote across; they also answer
      // Enter on an empty item by leaving the list, which is their own rule.
      return false;
    }

    const atBlockStart = tr.selection.$anchor.parentOffset === 0;
    const blockEmpty = blockContent.node.childCount === 0;
    const indented = tr.doc.resolve(bnBlock.beforePos).depth > 1;
    const quoted = blockContent.node.attrs[QUOTED] === true;

    if (blockEmpty) {
      if (!quoted || (atBlockStart && indented)) {
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
    return splitCarryingQuote(tr, tr.selection.from, atBlockStart);
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
 * The three list types are handled here rather than in each block's own
 * extension, so that one file decides what Enter does; the built-in list
 * bindings still exist and are overridden by this one.
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
      const type = editor.transact(
        (tr) => getBlockInfoFromSelection(tr).blockNoteType,
      );
      const listType = LIST_ITEM_TYPES.find((each) => each === type);
      if (listType !== undefined) {
        return handleListEnter(editor, listType);
      }
      return handleProseEnter(editor);
    },
  },
}) as never);
