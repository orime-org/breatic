// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the selection goes when the reader enters one of a block's own
 * controls from a body that does not hold the focus (inner#1127, design
 * 3.5.1): the selection the reader left elsewhere counts as gone, and the one
 * put in its place is on the block the control belongs to.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import { contentRangeOf, rowById } from '@web/spaces/document/document-row-by-id';

/**
 * Whether a block's content holds no words: a picture, a video, an audio, a
 * divider, or a block this build does not know. Such a block is selected
 * whole.
 * @param content - The block's content node.
 * @returns True when it has no words.
 */
export function isWordless(content: PMNode): boolean {
  return !content.isTextblock && content.type.spec.tableRole === undefined && content.childCount === 0;
}

/**
 * Selects whole the wordless block a content element draws, unless it already is.
 * @param view - The view.
 * @param element - The block's content element.
 * @returns True when that block is wordless and is now selected.
 */
export function selectWordlessBlock(view: EditorView, element: Element): boolean {
  const at = view.posAtDOM(element, 0);
  const $at = view.state.doc.resolve(at);
  // Inside a block's words the element draws a block with words.
  if ($at.parent.inlineContent) return false;
  const node = $at.nodeAfter;
  if (node === null || !isWordless(node)) return false;
  const selection = NodeSelection.create(view.state.doc, at);
  if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
  return true;
}

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
  if (isWordless(content)) {
    return selectionOverBlockContent(doc, blockId);
  }
  const range = contentRangeOf(row)!;
  if (content.isTextblock) return TextSelection.create(doc, range.from);
  // A table, or any block whose words sit deeper: the first place for text inside it.
  return Selection.findFrom(doc.resolve(range.from), 1, true) ?? state.selection;
}
