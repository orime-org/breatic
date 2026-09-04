// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ordered list item this Space uses.
 *
 * BlockNote ships `numberedListItem` with one extension carrying an input
 * rule, two keyboard shortcuts and an indexing plugin. That plugin is the sole
 * writer of the `data-index` attribute its built-in number is drawn from, and
 * this Space draws numbers from its own decoration instead
 * (`document-decorations.ts`): two node decorations writing the same
 * attribute would leave the winner to plugin order. There is no way to drop
 * one plugin out of that extension, so the extension is rebuilt without it,
 * and everything else it carried is rebuilt alongside.
 *
 * What the rebuilt extension carries, and how each differs:
 *
 * - The input rule stores no starting number. Where an ordered list starts is
 *   `#944`; until it exists, the digits a user types are the trigger and
 *   nothing more.
 * - Enter carries the quote across. A quote is a prop on the block here, and
 *   `splitBlockTr` hands the new block `attrs: {}`, so a user pressing Enter
 *   at the end of a quoted line would land outside the quote (A7b).
 * - The chord that turns a block into this kind is not here. All nine live in
 *   `document-block-chords.ts`, off the table the menu prints from, so a key
 *   and the row beside it cannot say different things.
 */

import {
  createExtension,
  defaultBlockSpecs,
  getBlockInfo,
  getBlockInfoFromSelection,
  getNearestBlockPos,
  getPmSchema,
  updateBlockTr,
} from '@blocknote/core';
import type { Transaction } from '@tiptap/pm/state';

/** The block type this file rebuilds. */
export const ORDERED_LIST = 'numberedListItem';

/** The prop that says a block sits inside a quote. */
export const QUOTED = 'quoted';

/** What the editor object offers the handlers below. */
export interface ListEditor {
  readonly prosemirrorState: { readonly selection: unknown };
  transact: <T>(run: (tr: Transaction) => T) => T;
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
 * @param keepType - Whether the new block keeps this one's type.
 * @returns Whether the split happened.
 */
export function splitCarryingQuote(
  tr: Transaction,
  posInBlock: number,
  keepType = true,
): boolean {
  const info = getBlockInfo(getNearestBlockPos(tr.doc, posInBlock));
  if (!info.isBlockContainer) {
    return false;
  }
  const schema = getPmSchema(tr);
  const quoted = info.blockContent.node.attrs[QUOTED];
  tr.split(posInBlock, 2, [
    { type: info.bnBlock.node.type, attrs: {} },
    {
      type: keepType ? info.blockContent.node.type : schema.nodes['paragraph'],
      attrs: { [QUOTED]: quoted },
    },
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
export function handleListEnter(
  editor: ListEditor,
  listItemType: string,
): boolean {
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

/** What one entry of a block spec's `extensions` array is. */
type ListExtension = NonNullable<
  typeof defaultBlockSpecs.numberedListItem.extensions
>[number];

/** One list kind, and everything its extension has to carry. */
interface ListKind {
  /** The block type. */
  readonly type: string;
  /** The markdown shorthands that open this kind, and what each sets. */
  readonly inputRules: readonly {
    readonly find: RegExp;
    readonly props?: Readonly<Record<string, unknown>>;
  }[];
  /** Whether typing the shorthand inside a heading is ignored. */
  readonly notInHeadings: boolean;
}

/**
 * The three list kinds, with what BlockNote gives each of them.
 *
 * The ordered kind's rule stores no starting number: where a list starts is
 * `#944`, and until then the digits a user types are the trigger and nothing
 * more.
 */
const LIST_KINDS: readonly ListKind[] = [
  {
    type: ORDERED_LIST,
    inputRules: [{ find: /^\s?(\d+)\.\s$/ }],
    notInHeadings: true,
  },
  {
    type: 'bulletListItem',
    inputRules: [{ find: /^\s?[-+*]\s$/ }],
    notInHeadings: true,
  },
  {
    type: 'checkListItem',
    inputRules: [
      { find: /^\s?\[\s*\]\s$/, props: { checked: false } },
      { find: /^\s?\[[Xx]\]\s$/, props: { checked: true } },
    ],
    notInHeadings: false,
  },
];

/**
 * Builds the one extension a list kind carries.
 *
 * Everything BlockNote's own extension carried is here except the ordered
 * kind's indexing plugin, which was the sole writer of `data-index` and would
 * otherwise fight this Space's own numbering decoration for that attribute.
 * @param kind - Which list to build it for.
 * @returns The extension.
 */
function buildListExtension(kind: ListKind): ListExtension {
  return createExtension({
    key: `document-list-${kind.type}`,
    keyboardShortcuts: {
      Enter: ({ editor }: { editor: ListEditor }) =>
        handleListEnter(editor, kind.type),
    },
    inputRules: kind.inputRules.map((rule) => ({
      find: rule.find,
      replace({ editor }: { editor: ListEditor }) {
        if (kind.notInHeadings) {
          const info = getBlockInfoFromSelection(
            editor.prosemirrorState as never,
          );
          if (info.blockNoteType === 'heading') {
            return undefined;
          }
        }
        return { type: kind.type, props: { ...(rule.props ?? {}) } };
      },
    })),
  } as never) as ListExtension;
}

/**
 * The three list item specs, each with this Space's extension in place of the
 * one it ships with.
 *
 * Replacing rather than adding: each extension becomes its own keymap plugin,
 * and the ones a block registers are reached before anything the assembly
 * passes in, so a second Enter binding would never be run.
 * @returns The three specs, for `withProps` to extend.
 */
export function buildListItemSpecs(): {
  numberedListItem: typeof defaultBlockSpecs.numberedListItem;
  bulletListItem: typeof defaultBlockSpecs.bulletListItem;
  checkListItem: typeof defaultBlockSpecs.checkListItem;
  } {
  const [ordered, bullet, check] = LIST_KINDS;
  return {
    numberedListItem: {
      ...defaultBlockSpecs.numberedListItem,
      extensions: [buildListExtension(ordered!)],
    },
    bulletListItem: {
      ...defaultBlockSpecs.bulletListItem,
      extensions: [buildListExtension(bullet!)],
    },
    checkListItem: {
      ...defaultBlockSpecs.checkListItem,
      extensions: [buildListExtension(check!)],
    },
  };
}
