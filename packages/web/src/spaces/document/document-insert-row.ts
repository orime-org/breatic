// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Making, and unmaking, the block the insert menu opens in.
 *
 * The menu cannot exist before the block does: its query is document text
 * (`SuggestionMenu.ts:331-334` reads it with `doc.textBetween`) and it closes
 * the moment the caret leaves the block the query started in (`:324-326`). So
 * the plus makes the block first, and a dismissal that chose nothing takes it
 * back out — which is what acceptance A14 asks for, read from the reader's
 * side: after Escape the document is as it was.
 *
 * Clearing the typed query is the menu's own job (`clearQuery`), and it comes
 * first: what the reader typed is document text too, and {@link withdrawRow}
 * deliberately keeps a block that holds any.
 */

import type { BlockNoteEditor } from '@blocknote/core';

import { rowShowsSomething } from '@web/spaces/document/document-hovered-block';
import { insertPlanFor } from '@web/spaces/document/document-insert-plan';

/** The editor these two work on. */
export type InsertEditor = BlockNoteEditor<never, never, never>;

/** The part of a BlockNote block this file reads. */
export interface PressedBlock {
  /** Its id, which the editor's block API addresses it by. */
  readonly id: string;
  /** Which kind of block it is. */
  readonly type: string;
  /** Its props, of which only the quote matters here. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Its own inline content. */
  readonly content?: readonly unknown[];
  /** Blocks nested under it. */
  readonly children?: readonly PressedBlock[];
}

/**
 * Makes the block the insert menu will open in, and puts the caret there.
 *
 * A row showing nothing is already that block, so nothing is made and the
 * caret simply moves there ({@link insertPlanFor} decides which rows those
 * are). Otherwise one is made where the reader sees the next row: directly
 * under the pressed row and before anything indented under it. That last part
 * is why this does not hand the pressed row to `insertBlocks` with `'after'` —
 * `insertBlocks.ts:41-42` advances by the container's `nodeSize`, and a
 * container holds its nested blocks (`BlockContainer.ts:27`), so the new row
 * would land below the whole subtree. Referencing the first child with
 * `'before'` lands it where the reader pointed instead.
 * @param editor - The editor to write to.
 * @param row - The block the plus was pressed on.
 * @returns The id of the block that was made, or undefined when none was.
 * @throws {Error} When the pressed block is no longer in the document.
 */
export function insertRowForMenu(
  editor: InsertEditor,
  row: PressedBlock,
): string | undefined {
  const plan = insertPlanFor(row);
  if (plan.where === 'inPlace') {
    editor.setTextCursorPosition(row.id, 'start');
    return undefined;
  }

  const firstChild = row.children?.[0];
  const made = editor.insertBlocks(
    [{ type: 'paragraph', props: plan.props } as never],
    firstChild?.id ?? row.id,
    firstChild === undefined ? 'after' : 'before',
  )[0] as { id: string } | undefined;
  if (made === undefined) {
    throw new Error(`could not make a row under the block ${row.id}`);
  }

  editor.setTextCursorPosition(made.id, 'start');
  return made.id;
}

/**
 * Takes that block back out, if taking it out costs nobody anything.
 *
 * Called when the menu closes with no command chosen. Two ways the block is
 * not ours to remove any more: it is already gone (someone else deleted it, or
 * a command replaced it), or it holds something — a co-editor can write into
 * it while the menu is open, and their text would go with it.
 * @param editor - The editor to write to.
 * @param blockId - The block {@link insertRowForMenu} made.
 */
export function withdrawRow(editor: InsertEditor, blockId: string): void {
  const block = editor.getBlock(blockId) as PressedBlock | undefined;
  if (block === undefined) return;
  if (rowShowsSomething(block)) return;

  editor.removeBlocks([blockId]);
}
