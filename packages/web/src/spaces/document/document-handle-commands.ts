// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two block handle commands that act on a whole block: copy it, remove it.
 *
 * Both take the block the pointer is over rather than the reader's selection
 * (A5), so both address it by id and neither touches the caret.
 *
 * The shapes every command off this handle takes live here too — the editor it
 * writes to and the row it is about. They were declared twice, once here and
 * once in `document-insert-row`, under two names for one editor type and two
 * spellings of one block.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';

import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';

/** The editor these commands work on. */
export type HandleEditor = BlockNoteEditor<never, never, never>;

/** The part of a BlockNote block the handle's commands read. */
export interface PressedBlock {
  /** Its id, which the editor's block API addresses it by. */
  readonly id: string;
  /** Which kind of block it is. */
  readonly type: string;
  /** Its props. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Its own inline content. */
  readonly content?: readonly unknown[];
  /** Blocks nested under it. */
  readonly children?: readonly PressedBlock[];
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
export function duplicateRow(editor: HandleEditor, row: PressedBlock): void {
  editor.insertBlocks([withoutIds(row) as never], row.id, 'after');
}

/**
 * The block as a partial one the editor will mint new ids for.
 * @param block - The block to copy.
 * @returns The same content and props, no ids.
 */
function withoutIds(block: PressedBlock): Record<string, unknown> {
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

/** Which way a block can be indented from where it stands. */
export interface IndentReach {
  /** There is a block before it in its group to nest under. */
  readonly in: boolean;
  /** It is nested, so it can come out one level. */
  readonly out: boolean;
}

/**
 * Which way a block can be indented: the same two questions BlockNote's
 * `canNestBlock` and `canUnnestBlock` ask of the caret's block
 * (`nestBlock.ts:194-208`), asked of the block named here.
 * @param doc - The document.
 * @param blockId - The block.
 * @returns Which way it can go; neither when no block carries the id.
 */
export function indentReach(doc: PMNode, blockId: string): IndentReach {
  let reach: IndentReach = { in: false, out: false };
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer' || node.attrs['id'] !== blockId) {
      return true;
    }
    const $before = doc.resolve(pos);
    reach = { in: $before.nodeBefore !== null, out: $before.depth > 1 };
    return false;
  });
  return reach;
}

/**
 * Indents or outdents the named block, leaving the reader's selection where it
 * was.
 *
 * BlockNote nests whatever `tr.selection` is in (`nestBlock.ts:19,163`), so the
 * selection is put on the block for the step and the reader's own is mapped
 * through and put back in the same transaction.
 * @param editor - The editor to write to.
 * @param blockId - The block.
 * @param inward - In one level, or out one level.
 * @throws {Error} When no block carries the id.
 */
export function indentRow(editor: HandleEditor, blockId: string, inward: boolean): void {
  editor.transact((tr) => {
    const reader = tr.selection;
    const written = tr.mapping.maps.length;
    tr.setSelection(selectionOverBlockContent(tr.doc, blockId));
    if (inward) {
      editor.nestBlock();
    } else {
      editor.unnestBlock();
    }
    tr.setSelection(reader.map(tr.doc, tr.mapping.slice(written)));
  });
}
