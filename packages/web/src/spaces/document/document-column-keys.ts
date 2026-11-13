// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Backspace and Delete at a column's edges (inner#1314 design §5.5).
 *
 * - In a column whose only block is an empty paragraph, either key deletes
 *   the column; a group left with one column dissolves; the caret goes to the
 *   end of the column before (or the start of the one after).
 * - At the start of a column's first block, Backspace stays in the column
 *   after the body's own first step, as at a cell's edge; at the end of a
 *   column's last block, Delete does nothing. BlockNote's own keys would
 *   move the block out of the column instead (`KeyboardShortcutsExtension.ts`
 *   `moveBlockOutAndPlaceCaret`).
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-nodes';
import { firstStepAtStart } from '@web/spaces/document/document-table-keys';

/** The part of the editor the keys use. */
interface KeysEditor {
  readonly prosemirrorView: EditorView;
}

/** Where the caret's column stands. */
interface ColumnAt {
  /** The depth of the column. */
  readonly depth: number;
  /** The depth of the caret's block container. */
  readonly container: number;
}

/**
 * The column the caret's block sits directly in.
 * @param $head - The caret.
 * @returns The column and container depths, or null outside a column.
 */
function columnOf($head: ResolvedPos): ColumnAt | null {
  for (let depth = $head.depth; depth > 1; depth -= 1) {
    if ($head.node(depth).type.name !== 'blockContainer') continue;
    return $head.node(depth - 1).type.name === DOC_COLUMN ? { depth: depth - 1, container: depth } : null;
  }
  return null;
}

/**
 * Whether a column holds only one empty paragraph.
 * @param column - The column.
 * @returns True when it does.
 */
function holdsOneEmptyParagraph(column: PMNode): boolean {
  if (column.childCount !== 1) return false;
  const row = column.firstChild!;
  return row.childCount === 1 && row.firstChild!.type.name === 'paragraph' && row.firstChild!.content.size === 0;
}

/**
 * Deletes the caret's empty column, dissolving its group when one column is
 * left, and puts the caret beside where the column stood.
 * @param view - The editor view.
 * @param $head - The caret.
 * @param at - The caret's column.
 * @returns True once done.
 */
function deleteEmptyColumn(view: EditorView, $head: ResolvedPos, at: ColumnAt): boolean {
  const { state } = view;
  const group = $head.node(at.depth - 1);
  const groupPos = $head.before(at.depth - 1);
  const index = $head.index(at.depth - 1);
  const tr = state.tr;
  if (group.childCount === 2) {
    const other = group.child(index === 0 ? 1 : 0);
    tr.replaceWith(groupPos, groupPos + group.nodeSize, other.content);
    const end = index === 0 ? groupPos : groupPos + other.content.size;
    tr.setSelection(Selection.near(tr.doc.resolve(end), index === 0 ? 1 : -1));
  } else {
    const columnPos = $head.before(at.depth);
    tr.delete(columnPos, columnPos + group.child(index).nodeSize);
    const near = index === 0 ? columnPos : columnPos - 1;
    tr.setSelection(Selection.near(tr.doc.resolve(near), index === 0 ? 1 : -1));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Backspace in a column.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function backspaceInColumn(view: EditorView): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== 0) return false;
  const at = columnOf($head);
  if (at === null) return false;
  const column = $head.node(at.depth);
  if (holdsOneEmptyParagraph(column) && $head.node(at.depth - 1).type.name === DOC_COLUMN_LIST) {
    return deleteEmptyColumn(view, $head, at);
  }
  if ($head.index(at.depth) !== 0) return false;
  return firstStepAtStart(view, $head, at.container) ?? true;
}

/**
 * Delete in a column.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function deleteInColumn(view: EditorView): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== $head.parent.content.size) return false;
  const at = columnOf($head);
  if (at === null) return false;
  const column = $head.node(at.depth);
  if (holdsOneEmptyParagraph(column)) return deleteEmptyColumn(view, $head, at);
  return $head.index(at.depth) === column.childCount - 1;
}

/**
 * The extension that binds the keys at a column's edges.
 * @returns The extension, for the assembly to register.
 */
export const documentColumnKeysExtension = createExtension(() => ({
  key: 'document-column-keys',
  runsBefore: ['document-table-keys'],
  keyboardShortcuts: {
    Backspace: ({ editor }: { editor: KeysEditor }) => backspaceInColumn(editor.prosemirrorView),
    Delete: ({ editor }: { editor: KeysEditor }) => deleteInColumn(editor.prosemirrorView),
  },
}));
