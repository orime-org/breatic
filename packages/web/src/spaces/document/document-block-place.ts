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

/** The element a block's own content draws: BlockNote's wrapper, or the fallback block itself. */
const BLOCK_CONTENT = '.bn-block-content, [data-unsupported-block]';

/**
 * Where the wordless block an element draws starts.
 * @param view - The view.
 * @param element - The block's content element.
 * @returns The position before that block, or null when it has words.
 */
function wordlessAt(view: EditorView, element: Element): number | null {
  const at = view.posAtDOM(element, 0);
  const $at = view.state.doc.resolve(at);
  // Inside a block's words the element draws a block with words.
  if ($at.parent.inlineContent) return null;
  const node = $at.nodeAfter;
  return node !== null && isWordless(node) ? at : null;
}

/**
 * The wordless block a press inside the body landed on.
 * @param view - The view.
 * @param target - What was pressed.
 * @returns That block's content element, or null when the press is not on one.
 */
export function wordlessBlockAt(view: EditorView, target: Element): Element | null {
  const block = target.closest(BLOCK_CONTENT);
  return block !== null && view.dom.contains(block) && wordlessAt(view, block) !== null ? block : null;
}

/**
 * Selects whole the wordless block a content element draws, unless it already is.
 * @param view - The view.
 * @param element - The block's content element.
 * @returns True when that block is wordless and is now selected.
 */
export function selectWordlessBlock(view: EditorView, element: Element): boolean {
  const at = wordlessAt(view, element);
  if (at === null) return false;
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
  if (isWordless(content)) return NodeSelection.create(doc, row.from + 1);
  const range = contentRangeOf(row)!;
  if (content.isTextblock) return TextSelection.create(doc, range.from);
  // A table, or any block whose words sit deeper: the first place for text inside it.
  return Selection.findFrom(doc.resolve(range.from), 1, true) ?? state.selection;
}
