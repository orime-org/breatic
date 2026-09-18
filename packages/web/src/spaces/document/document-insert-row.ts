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
 * It inherits the pressed row's quoting: the schema's default is
 * `quoted: false` (`document-schema-blocknote.ts:53`), and a row inserted
 * inside a quote has to stay in the quote, the way Enter's does.
 * @param editor - The editor to write to.
 * @param row - The block the menu was opened on.
 * @returns The id of the row that was made.
 * @throws {Error} When the pressed block is no longer in the document.
 */
export function insertRowForMenu(
  editor: HandleEditor,
  row: PressedBlock,
): string {
  const firstChild = row.children?.[0];
  const made = editor.insertBlocks(
    [
      {
        type: 'paragraph',
        props: { [QUOTED]: row.props?.[QUOTED] === true },
      } as never,
    ],
    firstChild?.id ?? row.id,
    firstChild === undefined ? 'after' : 'before',
  )[0] as { id: string } | undefined;
  if (made === undefined) {
    throw new Error(`could not make a row under the block ${row.id}`);
  }

  editor.setTextCursorPosition(made.id, 'start');
  return made.id;
}
