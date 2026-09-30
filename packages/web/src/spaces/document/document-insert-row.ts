// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The row the handle menu's insert-below command makes (A7).
 *
 * One transaction's worth of work: a paragraph directly under the pressed row,
 * carrying that row's own quoting, with the caret in it so the reader can type
 * straight away. What kind of row it becomes is the caller's next step
 * (`runBlockType`), so the document never holds a half-made row waiting on a
 * decision — which is why nothing here has to be taken back.
 */

import {
  type HandleEditor,
  type PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import { QUOTED } from '@web/spaces/document/document-list-block';

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
 * @param lead - Block types to place before the row, in order.
 * @returns The id of the row that was made.
 * @throws {Error} `Block with ID … not found`, from BlockNote's
 *   `insertBlocks`, when the pressed block is no longer in the document.
 */
export function insertRowForMenu(
  editor: HandleEditor,
  row: PressedBlock,
  lead: readonly string[] = [],
): string {
  const quoted = row.props?.[QUOTED] === true;
  const firstChild = row.children?.[0];
  const made = editor.insertBlocks(
    [...lead, 'paragraph'].map((type) => ({
      type,
      props: { [QUOTED]: quoted },
    })) as never,
    firstChild?.id ?? row.id,
    firstChild === undefined ? 'after' : 'before',
  ) as { id: string }[];
  // `insertBlocks` hands back one block for every block it was given.
  const rowMade = made[made.length - 1]!;
  editor.setTextCursorPosition(rowMade.id, 'start');
  return rowMade.id;
}
