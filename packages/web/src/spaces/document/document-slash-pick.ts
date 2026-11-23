// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What a pick in the slash menu does to the document (inner#1125 design 5.5,
 * 5.6, 5.9).
 *
 * The trigger and the query typed after it are removed in the same write that
 * inserts the pick: a block left empty (no text and no inline node) turns into
 * the pick, whatever its type, and any other block gets the pick below it.
 * Media wait for the file picker, so their query stays until the files land.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

import type { BlockSpec } from '@web/spaces/document/document-file-input';
import type { HandleEditor, PressedBlock } from '@web/spaces/document/document-handle-commands';
import {
  fillEmptyRow,
  insertBelow,
  insertMediaBelow,
  insertMediaOnRow,
  type InsertChoice,
} from '@web/spaces/document/document-insert-row';

/** Where the trigger and query sit: the row, how far into its text, and what was typed. */
export interface SlashTyped {
  /** The row the menu was opened on. */
  readonly blockId: string;
  /** Positions into the row's content where the trigger starts. */
  readonly offset: number;
  /** The trigger and the query after it. */
  readonly typed: string;
}

/** A row's text node and where its text starts in the document. */
interface RowText {
  readonly node: PMNode;
  readonly start: number;
}

/**
 * The text of the block a block id names, and its first position.
 * @param doc - The document.
 * @param blockId - The block.
 * @returns Its content node and start, or undefined once it is gone.
 */
function rowText(doc: PMNode, blockId: string): RowText | undefined {
  let found: RowText | undefined;
  doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.attrs['id'] !== blockId) return true;
    const content = node.firstChild;
    // blockContainer opens at pos, its content node one further in.
    if (content !== null) found = { node: content, start: pos + 2 };
    return false;
  });
  return found;
}

/**
 * Where a typed trigger and query sit in a row. The offset counts positions,
 * as the caret does, so an inline formula or a line break before the trigger
 * counts as one.
 * @param editor - The editor.
 * @param blockId - The row.
 * @param typed - The trigger and the query.
 * @param offset - Positions into the row's content where the trigger starts.
 * @returns The record, or undefined when the row does not hold the text there.
 */
export function slashTyped(
  editor: HandleEditor,
  blockId: string,
  typed: string,
  offset: number,
): SlashTyped | undefined {
  const row = rowText(editor.prosemirrorState.doc, blockId);
  if (row === undefined || !holdsTyped(row.node, offset, typed)) return undefined;
  return { blockId, offset, typed };
}

/**
 * Whether a row's content holds the typed text at an offset.
 * @param node - The row's content node.
 * @param offset - Positions into it.
 * @param typed - The trigger and the query.
 * @returns True when the text is there.
 */
function holdsTyped(node: PMNode, offset: number, typed: string): boolean {
  const end = offset + typed.length;
  return offset >= 0 && end <= node.content.size && node.textBetween(offset, end) === typed;
}

/**
 * Removes the typed trigger and query when they are still where they were.
 * @param tr - The transaction to remove them in.
 * @param record - Where they were typed.
 * @returns True when they were removed.
 */
function removeTyped(tr: Transaction, record: SlashTyped): boolean {
  const row = rowText(tr.doc, record.blockId);
  if (row === undefined || !holdsTyped(row.node, record.offset, record.typed)) return false;
  const from = row.start + record.offset;
  tr.delete(from, from + record.typed.length);
  return true;
}

/**
 * The row as BlockNote reads it now.
 * @param editor - The editor.
 * @param blockId - The row.
 * @returns The row, or undefined once it is gone.
 */
function rowNow(editor: HandleEditor, blockId: string): PressedBlock | undefined {
  return editor.getBlock(blockId) as PressedBlock | undefined;
}

/**
 * Whether a row's content is empty: no text and no inline node.
 * @param doc - The document.
 * @param blockId - The row.
 * @returns True for a row with empty content, whatever its type.
 */
function rowIsEmpty(doc: PMNode, blockId: string): boolean {
  return rowText(doc, blockId)?.node.content.size === 0;
}

/**
 * Carries out a pick: removes the trigger and query, then turns the row into
 * the pick when no text is left, or adds the pick below it.
 * @param editor - The editor.
 * @param record - Where the trigger and query were typed.
 * @param choice - The pick.
 * @returns The id of a formula block made, whose box opens next.
 */
export function pickInSlashMenu(editor: HandleEditor, record: SlashTyped, choice: InsertChoice): string | undefined {
  // Two writes: the insert helpers read the row back from the editor, which
  // a write still open does not show them. The caller runs both as one undo
  // step (design 5.6).
  editor.transact((tr) => {
    removeTyped(tr, record);
  });
  const row = rowNow(editor, record.blockId);
  if (row === undefined) return undefined;
  return rowIsEmpty(editor.prosemirrorState.doc, record.blockId)
    ? fillEmptyRow(editor, row, choice)
    : insertBelow(editor, row, choice);
}

/**
 * Lands the files a media pick chose: removes the trigger and query when they
 * are still there, then puts the files above an emptied row or below a row
 * with text. Read by block id, so a row moved meanwhile is still found.
 * @param editor - The editor.
 * @param record - Where the trigger and query were typed.
 * @param blocks - The media blocks.
 * @returns False when the row is gone and nothing landed.
 */
export function landSlashMedia(editor: HandleEditor, record: SlashTyped, blocks: readonly BlockSpec[]): boolean {
  if (rowNow(editor, record.blockId) === undefined) return false;
  editor.transact((tr) => {
    removeTyped(tr, record);
    const row = rowNow(editor, record.blockId);
    if (row === undefined) return;
    if (rowIsEmpty(tr.doc, record.blockId)) insertMediaOnRow(editor, row, blocks);
    else insertMediaBelow(editor, row, blocks);
  });
  return true;
}
