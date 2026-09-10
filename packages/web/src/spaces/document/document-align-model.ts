// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which selections the alignment control has anything to say about.
 *
 * Alignment reaches the block types that carry a line of text the reader sets
 * the edge of; it says nothing about a list item's marker or a code block's
 * gutter. The block types themselves come from `document-block-ticks.ts`.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';

import {
  blocksUnder,
  rowOf,
  type BlockTypeId,
  type BlockUnder,
} from '@web/spaces/document/document-block-ticks';

/** The block types alignment has anything to say about. */
const ALIGNABLE = new Set<BlockTypeId>([
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
]);

/**
 * The blocks under the selection that alignment reaches.
 *
 * Three answers come off this one list — whether the slot is live, which row it
 * draws as active, and which blocks a press writes to — so they cannot disagree
 * about what is under the selection.
 * @param doc - The document.
 * @param selection - The selection over it.
 * @returns Those blocks, in document order.
 */
export function alignableUnder(
  doc: PMNode,
  selection: Selection,
): BlockUnder[] {
  return blocksUnder(doc, selection).filter(({ node }) => {
    const row = rowOf(node);
    return row !== undefined && ALIGNABLE.has(row);
  });
}

/**
 * Is there anything in the selection alignment would reach?
 *
 * One alignable block is enough: aligning a selection that runs from a heading
 * into a code block still moves the heading, so the control is live.
 * @param editor - The editor.
 * @returns Whether the selection holds at least one alignable block.
 */
export function selectionCanAlign(
  editor: BlockNoteEditor<never, never, never>,
): boolean {
  const { doc, selection } = editor.prosemirrorState;
  return alignableUnder(doc, selection).length > 0;
}
