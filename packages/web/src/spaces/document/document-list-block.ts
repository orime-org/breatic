// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ordered list item this Space uses.
 *
 * BlockNote ships `numberedListItem` with one extension carrying an input
 * rule, two keyboard shortcuts and an indexing plugin. That plugin is the sole
 * writer of the `data-index` attribute its built-in number is drawn from, and
 * this Space draws numbers from its own decoration instead
 * (`document-numbering-decoration.ts`): two node decorations writing the same
 * attribute would leave the winner to plugin order. There is no way to drop
 * one plugin out of that extension, so the extension is rebuilt without it,
 * and everything else it carried is rebuilt alongside.
 *
 * Two of those three differ from the original:
 *
 * - The input rule stores no starting number. Where an ordered list starts is
 *   `#944`; until it exists, the digits a user types are the trigger and
 *   nothing more.
 * - Enter carries the quote across. A quote is a prop on the block here, and
 *   `splitBlockTr` hands the new block `attrs: {}`, so a user pressing Enter
 *   at the end of a quoted line would land outside the quote (A7b).
 */

import {
  createExtension,
  defaultBlockSpecs,
  getBlockInfo,
  getBlockInfoFromSelection,
  getNearestBlockPos,
  updateBlockTr,
} from '@blocknote/core';
import type { Transaction } from '@tiptap/pm/state';

/** The block type this file rebuilds. */
const ORDERED_LIST = 'numberedListItem';

/** The prop that says a block sits inside a quote. */
const QUOTED = 'quoted';

/** What the editor object offers the handlers below. */
interface ListEditor {
  readonly prosemirrorState: { readonly selection: unknown };
  transact: <T>(run: (tr: Transaction) => T) => T;
  getTextCursorPosition: () => { block: { type: string } };
  updateBlock: (
    block: unknown,
    update: { type: string; props: Record<string, unknown> },
  ) => void;
  readonly schema: {
    readonly blockSchema: Record<string, { readonly content: string }>;
  };
}

/**
 * Splits the block at a position, carrying the quote into the new one.
 *
 * A rebuild of `splitBlockTr`, which `@blocknote/core` keeps to itself while
 * exporting everything it depends on. The new block starts clean apart from
 * the quote: a pinned number belongs to the item the user pinned it on, and
 * the one after it counts along.
 * @param tr - The transaction to split in.
 * @param posInBlock - Where to split.
 * @returns Whether the split happened.
 */
function splitCarryingQuote(tr: Transaction, posInBlock: number): boolean {
  const info = getBlockInfo(getNearestBlockPos(tr.doc, posInBlock));
  if (!info.isBlockContainer) {
    return false;
  }
  const quoted = info.blockContent.node.attrs[QUOTED];
  tr.split(posInBlock, 2, [
    { type: info.bnBlock.node.type, attrs: {} },
    { type: info.blockContent.node.type, attrs: { [QUOTED]: quoted } },
  ]);
  return true;
}

/**
 * What Enter does inside a list item.
 *
 * An empty item leaves the list; a non-empty one splits into another item of
 * the same kind. A rebuild of `handleEnter`, which is internal.
 * @param editor - The editor Enter was pressed in.
 * @param listItemType - The list block type this handler belongs to.
 * @returns Whether this handler claimed the key.
 */
function handleListEnter(editor: ListEditor, listItemType: string): boolean {
  const { blockInfo, selectionEmpty } = editor.transact((tr) => ({
    blockInfo: getBlockInfoFromSelection(tr),
    selectionEmpty: tr.selection.anchor === tr.selection.head,
  }));

  if (!blockInfo.isBlockContainer) {
    return false;
  }
  const { bnBlock, blockContent } = blockInfo;
  if (blockContent.node.type.name !== listItemType || !selectionEmpty) {
    return false;
  }

  if (blockContent.node.childCount === 0) {
    editor.transact((tr) => {
      updateBlockTr(tr, bnBlock.beforePos, { type: 'paragraph', props: {} });
    });
    return true;
  }

  return editor.transact((tr) => {
    tr.deleteSelection();
    tr.scrollIntoView();
    return splitCarryingQuote(tr, tr.selection.from);
  });
}

/** The extension the rebuilt block carries, indexing plugin left out. */
const orderedListExtension = createExtension({
  key: 'document-ordered-list',
  inputRules: [
    {
      find: /^\s?(\d+)\.\s$/,
      replace({ editor }: { editor: ListEditor }) {
        const info = getBlockInfoFromSelection(
          editor.prosemirrorState as never,
        );
        if (info.blockNoteType === 'heading') {
          return undefined;
        }
        return { type: ORDERED_LIST, props: {} };
      },
    },
  ],
  keyboardShortcuts: {
    Enter: ({ editor }: { editor: ListEditor }) =>
      handleListEnter(editor, ORDERED_LIST),
    'Mod-Shift-7': ({ editor }: { editor: ListEditor }) => {
      const position = editor.getTextCursorPosition();
      if (editor.schema.blockSchema[position.block.type]?.content !== 'inline') {
        return false;
      }
      editor.updateBlock(position.block, { type: ORDERED_LIST, props: {} });
      return true;
    },
  },
} as never);

/**
 * The ordered list item spec, rebuilt without the indexing plugin.
 * @returns The spec, ready for `withProps` to add this Space's props to.
 */
export function buildOrderedListItemSpec(): typeof defaultBlockSpecs.numberedListItem {
  return {
    ...defaultBlockSpecs.numberedListItem,
    extensions: [orderedListExtension],
  } as typeof defaultBlockSpecs.numberedListItem;
}
