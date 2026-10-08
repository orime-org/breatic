// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the selection goes when the reader enters one of a block's own
 * controls from a body that does not hold the focus (inner#1127, design
 * 3.5.1): the selection the reader left elsewhere counts as gone, and the one
 * put in its place is on the block the control belongs to.
 */

import { Selection, TextSelection, type EditorState } from '@tiptap/pm/state';

import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import { contentRangeOf, rowById } from '@web/spaces/document/document-row-by-id';

/**
 * The selection for a block: a block with no text (a picture, a video, an
 * audio, a divider) selected whole, a table's first cell, and the start of any
 * other block's words.
 * @param state - The editor's state.
 * @param blockId - The block.
 * @returns The selection, or the current one when the document no longer holds the block.
 */
export function placeOnBlock(state: EditorState, blockId: string): Selection {
  const { doc } = state;
  const row = rowById(doc, blockId);
  const content = row?.node.firstChild;
  if (row === undefined || content === null || content === undefined) return state.selection;
  if (!content.isTextblock && content.type.spec.tableRole === undefined && content.childCount === 0) {
    return selectionOverBlockContent(doc, blockId);
  }
  const range = contentRangeOf(row)!;
  if (content.isTextblock) return TextSelection.create(doc, range.from);
  // A table, or any block whose words sit deeper: the first place for text inside it.
  return Selection.findFrom(doc.resolve(range.from), 1, true) ?? state.selection;
}
