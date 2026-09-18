// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two block handle commands that act on a whole block: copy it, remove it.
 *
 * Both take the block the pointer is over rather than the reader's selection
 * (A5), so both address it by id and neither touches the caret.
 */

import type { BlockNoteEditor } from '@blocknote/core';

/** The editor these commands work on. */
export type HandleEditor = BlockNoteEditor<never, never, never>;

/** The part of a BlockNote block these commands read. */
export interface HandleBlock {
  /** Its id, which the editor's block API addresses it by. */
  readonly id: string;
  /** Which kind of block it is. */
  readonly type: string;
  /** Its props. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Its own inline content. */
  readonly content?: unknown;
  /** Blocks nested under it. */
  readonly children?: readonly HandleBlock[];
}

/**
 * Puts a copy of the block below it, with everything indented under it.
 *
 * Below the whole subtree, which is what `insertBlocks` with `'after'` does on
 * its own here (`insertBlocks.ts:41-42` advances by the container's
 * `nodeSize`) — the copy of a block that has nested blocks belongs after them,
 * not between the original and its children.
 *
 * The id is dropped on the way in so the editor mints fresh ones: reusing the
 * ids would put the same block in the document twice, and every command that
 * addresses a block by id would then find whichever comes first.
 *
 * THE CALLER HANDS OVER A ROW IT HAS JUST READ. `insertBlocks` throws on an id
 * the document no longer holds, and the row a menu is about can be taken away
 * while that menu stands open — so the judgement of whether the row is still
 * there belongs where the row is read, which is `DocumentBlockMenu`'s
 * `rowNow()`. Reading it again here would answer the same question twice in
 * one tick.
 * @param editor - The editor to write to.
 * @param row - The block to copy, as the document holds it now.
 */
export function duplicateRow(editor: HandleEditor, row: HandleBlock): void {
  editor.insertBlocks([withoutIds(row) as never], row.id, 'after');
}

/**
 * The block as a partial one the editor will mint new ids for.
 * @param block - The block to copy.
 * @returns The same content and props, no ids.
 */
function withoutIds(block: HandleBlock): Record<string, unknown> {
  return {
    type: block.type,
    props: { ...block.props },
    content: block.content,
    children: (block.children ?? []).map(withoutIds),
  };
}

/**
 * Removes the block, and everything indented under it.
 *
 * Removing the last block leaves one empty paragraph behind, which is what A9
 * asks for, and nothing here has to arrange it: the document requires at least
 * one block (`BlockGroup.ts:11` is `blockGroupChild+`), so ProseMirror fills
 * the required content back in as it applies the deletion. Measured — taking
 * the guard this once carried back out left
 * `document-handle-commands.test.ts`'s last case green, and that case is what
 * keeps an upgrade from changing the answer quietly.
 *
 * `removeBlocks` throws on an id the document no longer holds, and the caller
 * hands over a row it has just read — see `duplicateRow` above for where that
 * judgement lives.
 * @param editor - The editor to write to.
 * @param blockId - The block to remove, read from the document just now.
 */
export function deleteRow(editor: HandleEditor, blockId: string): void {
  editor.removeBlocks([blockId]);
}
