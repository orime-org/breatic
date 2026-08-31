// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which selections the alignment control has anything to say about.
 *
 * Alignment reaches the block types that carry a line of text the reader sets
 * the edge of; it says nothing about a list item's marker or a code block's
 * gutter. The block types themselves come from `document-block-model.ts`.
 */

import type { Editor } from '@tiptap/core';

import {
  blockTypeAt,
  selectedBlocks,
  type BlockTypeId,
} from '@web/spaces/document/document-block-model';

/** The block types alignment has anything to say about. */
const ALIGNABLE = new Set<BlockTypeId>([
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
]);

/**
 * Is there anything in the selection alignment would reach?
 *
 * One alignable block is enough: aligning a selection that runs from a heading
 * into a code block still moves the heading, so the control is live.
 * @param editor - The editor.
 * @returns Whether the selection holds at least one alignable block.
 */
export function selectionCanAlign(editor: Editor): boolean {
  const { doc } = editor.state;
  return selectedBlocks(editor.state).some((pos) => {
    const type = blockTypeAt(doc, pos);
    return type !== null && ALIGNABLE.has(type);
  });
}
