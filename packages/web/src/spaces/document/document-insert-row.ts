// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the insert menu does to the row it was opened on.
 *
 * Two entries open that menu. The grip menu's insert-below makes a new row
 * under the pressed one (#113, A7): a paragraph carrying that row's quoting,
 * with the caret in it, which the caller then turns into the type picked
 * (`runBlockType`), so the document never holds a half-made row waiting on a
 * decision. The plus on an empty paragraph puts the pick on that row itself
 * (#1097): the row keeps its id and becomes the type, or gets a divider above
 * it.
 */

import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';
import { runBlockType } from '@web/spaces/document/document-block-run';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { rowById } from '@web/spaces/document/document-row-by-id';
import {
  type HandleEditor,
  type PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import { QUOTED } from '@web/spaces/document/document-list-block';
import type { UploadGap } from '@web/spaces/document/document-upload-slots';

/** How many rows and columns a new table has. */
export interface TableSize {
  readonly rows: number;
  readonly cols: number;
}

/** One entry of the insert menu: a block type, the divider, or a table of a size. */
export type InsertChoice = BlockTypeId | typeof DIVIDER | { readonly table: TableSize };

/** A block for `insertBlocks` / `updateBlock`, as far as this module builds one. */
interface BlockSpec {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
}

/**
 * An empty table of a size.
 * @param size - Rows and columns.
 * @param quoted - Whether it sits in a quote.
 * @returns The block, every cell empty.
 */
function emptyTable(size: TableSize, quoted: boolean): BlockSpec {
  return {
    type: 'table',
    props: { [QUOTED]: quoted },
    content: {
      type: 'tableContent',
      rows: Array.from({ length: size.rows }, () => ({
        cells: Array.from({ length: size.cols }, () => []),
      })),
    },
  };
}

/**
 * Makes the row under the pressed one, and puts the caret in it.
 *
 * The new row goes directly under the pressed row's own content and BEFORE
 * anything indented under it, which is why the pressed row is not handed to
 * `insertBlocks` with `'after'` — `insertBlocks.ts:41-42` advances by the
 * container's `nodeSize`, and a container holds its nested blocks
 * (`BlockContainer.ts:27`), so the new row would land below the whole subtree.
 * Referencing the first child with `'before'` is the same place the reader
 * gets from pressing Enter.
 *
 * Blocks named in `lead` go in first, in the same place, and the row comes
 * after them: the Divider entry is a divider with the row under it (#124, A2).
 *
 * Everything made inherits the pressed row's quoting: the schema's default is
 * `quoted: false` (`document-schema-blocknote.ts:53`), and a row inserted
 * inside a quote has to stay in the quote, the way Enter's does.
 * @param editor - The editor to write to.
 * @param row - The block the menu was opened on.
 * @param lead - Blocks to place before the row, in order.
 * @returns The id of the row that was made.
 * @throws {Error} `Block with ID … not found`, from BlockNote's
 *   `insertBlocks`, when the pressed block is no longer in the document.
 */
export function insertRowForMenu(
  editor: HandleEditor,
  row: PressedBlock,
  lead: readonly BlockSpec[] = [],
): string {
  const quoted = row.props?.[QUOTED] === true;
  const firstChild = row.children?.[0];
  const made = editor.insertBlocks(
    [...lead, { type: 'paragraph' }].map((block) => ({
      ...block,
      props: { ...block.props, [QUOTED]: quoted },
    })) as never,
    firstChild?.id ?? row.id,
    firstChild === undefined ? 'after' : 'before',
  ) as { id: string }[];
  // `insertBlocks` hands back one block for every block it was given.
  const rowMade = made[made.length - 1]!;
  editor.setTextCursorPosition(rowMade.id, 'start');
  return rowMade.id;
}

/**
 * The insert-below submenu's pick, made under the pressed row (#113 A7).
 *
 * A block type is a new row turned into that type; a divider is a divider with
 * the new row under it (#124 A2); a table is the table with the new row under
 * it and the caret in its first cell (inner#1126 A1), so the reader writes in
 * the table and has a line below it to carry on.
 * @param editor - The editor to write to.
 * @param row - The block the menu was opened on.
 * @param choice - The entry that was picked.
 * @throws {Error} `Block with ID … not found`, from BlockNote's
 *   `insertBlocks`, when the pressed block is no longer in the document.
 */
export function insertBelow(
  editor: HandleEditor,
  row: PressedBlock,
  choice: InsertChoice,
): void {
  if (choice === DIVIDER) {
    insertRowForMenu(editor, row, [{ type: DIVIDER }]);
  } else if (typeof choice === 'object') {
    const made = insertRowForMenu(editor, row, [emptyTable(choice.table, false)]);
    const table = editor.getPrevBlock(made) as { id: string } | undefined;
    if (table !== undefined) editor.setTextCursorPosition(table.id, 'start');
  } else {
    runBlockType(editor, choice, insertRowForMenu(editor, row), false);
  }
}

/**
 * The gap the insert-below submenu's media entries upload into
 * (inner#1127 A1).
 *
 * The row a divider or a table gets under it is made here, at the pick, with
 * the caret in it; the files go above that row. The upload finishing later
 * then only adds blocks — it moves no caret and makes no row, so the reader
 * typing elsewhere meanwhile is left where they are, and a batch of files
 * lands with nothing between them.
 * @param editor - The editor to write to.
 * @param row - The block the menu was opened on.
 * @returns The gap.
 * @throws {Error} `Block with ID … not found`, from BlockNote's
 *   `insertBlocks`, when the pressed block is no longer in the document.
 */
export function mediaGapBelow(editor: HandleEditor, row: PressedBlock): UploadGap {
  return gapAbove(editor, insertRowForMenu(editor, row));
}

/**
 * The gap the plus menu's media entries upload into: above the empty line it
 * was opened on, which keeps the caret (inner#1127 A1).
 * @param editor - The editor to write to.
 * @param row - The empty paragraph the plus is on.
 * @returns The gap.
 * @throws {Error} `Block with ID … not found`, from BlockNote, when the row is
 *   no longer in the document.
 */
export function mediaGapOnRow(editor: HandleEditor, row: PressedBlock): UploadGap {
  const gap = gapAbove(editor, row.id);
  editor.setTextCursorPosition(row.id, 'start');
  return gap;
}

/**
 * The gap just above a block.
 * @param editor - The editor.
 * @param id - The block the gap is above.
 * @returns The gap.
 * @throws {Error} When the document no longer holds the block.
 */
function gapAbove(editor: HandleEditor, id: string): UploadGap {
  const row = rowById(editor.prosemirrorState.doc, id);
  if (row === undefined) throw new Error(`Block with ID ${id} not found`);
  return row.from;
}

/**
 * Whether the handle shows the plus for this row (#1097, A1): a paragraph
 * with nothing in it. The same emptiness BlockNote's own add button reads
 * (`AddBlockButton.tsx`), held to paragraphs — an empty heading or list item
 * already carries a type the reader chose.
 * @param row - The row, as the document holds it now.
 * @returns True for an empty paragraph; false for anything else or no row.
 */
export function isEmptyParagraph(row: PressedBlock | undefined): boolean {
  return (
    row?.type === 'paragraph' &&
    Array.isArray(row.content) &&
    row.content.length === 0
  );
}

/**
 * Puts the chosen block on the empty paragraph itself (#1097, A3/A4).
 *
 * A block type becomes the row's own type, so the row keeps its id. The
 * divider goes above the row, which stays the empty paragraph under it — what
 * typing `---` at the start of a line leaves. The caret is set into the row in
 * both cases: the handle follows the pointer, so the reader's caret can be in
 * any other row, and the menu closing only hands the focus back.
 *
 * One transaction, so one undo takes it all back (A6).
 * @param editor - The editor to write to.
 * @param row - The empty paragraph the plus is on, read from the document now.
 * @param choice - The entry that was picked.
 * @throws {Error} `Block with ID … not found`, from BlockNote, when the row is
 *   no longer in the document.
 */
export function fillEmptyRow(
  editor: HandleEditor,
  row: PressedBlock,
  choice: InsertChoice,
): void {
  editor.transact(() => {
    if (typeof choice === 'object') {
      // `updateBlock` keeps the row's id and merges its props, so the quote
      // stays on the table it becomes.
      editor.updateBlock(row.id, emptyTable(choice.table, row.props?.[QUOTED] === true) as never);
    } else if (choice === DIVIDER) {
      editor.insertBlocks(
        [{ type: DIVIDER, props: { [QUOTED]: row.props?.[QUOTED] === true } }] as never,
        row.id,
        'before',
      );
    } else {
      runBlockType(editor, choice, row.id, false);
    }
    editor.setTextCursorPosition(row.id, 'start');
  });
}
