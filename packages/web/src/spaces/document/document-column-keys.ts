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
 * - Right under a group, Backspace moves the caret to the end of its last
 *   column; right above one, Delete does nothing: a table's edges
 *   (`document-table-keys.ts`), where BlockNote's own keys would move the
 *   block into the group or a block out of it.
 */

import { createExtension } from '@blocknote/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { columnAt, takeAwayColumnSpan } from '@web/spaces/document/document-column-span-selection';
import { DOC_COLUMN, DOC_COLUMN_LIST, holdsOneEmptyParagraph } from '@web/spaces/document/document-column-geometry';
import { containerDepth, firstStepAtStart } from '@web/spaces/document/document-table-keys';

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
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== 0) return false;
  const at = columnOf($head);
  if (at === null) {
    // Right under a group, as right under a table: the caret goes to the end
    // of the last column and nothing joins.
    const container = containerDepth($head);
    if (container < 1) return false;
    const $before = doc.resolve($head.before(container));
    if ($before.nodeBefore?.type.name !== DOC_COLUMN_LIST) return false;
    const step = firstStepAtStart(view, $head, container);
    if (step !== undefined) return step;
    const end = Selection.findFrom($before, -1);
    if (end === null) return false;
    view.dispatch(view.state.tr.setSelection(end).scrollIntoView());
    return true;
  }
  const column = $head.node(at.depth);
  if (holdsOneEmptyParagraph(column)) return deleteEmptyColumn(view, $head, at);
  if ($head.index(at.depth) !== 0) return false;
  return firstStepAtStart(view, $head, at.container) ?? true;
}

/**
 * Delete in a column.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function deleteInColumn(view: EditorView): boolean {
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== $head.parent.content.size) return false;
  const at = columnOf($head);
  if (at === null) {
    // Right above a group, as right above a table, it does nothing: what a
    // selection can stand on next is in a column only when a group starts
    // right after the block (`deleteAtEdge`).
    const next = Selection.findFrom(doc.resolve($head.after()), 1);
    return next !== null && columnAt(doc, next.from) !== null && columnAt(doc, next.from) !== columnAt(doc, $head.pos);
  }
  const column = $head.node(at.depth);
  if (holdsOneEmptyParagraph(column)) return deleteEmptyColumn(view, $head, at);
  // At the column's end it does nothing, as at a cell's (`deleteAtEdge`).
  const next = Selection.findFrom(doc.resolve($head.after()), 1);
  return next === null || next.from > $head.end(at.depth);
}

/**
 * The extension that binds the keys at a column's edges.
 * @returns The extension, for the assembly to register.
 */
export const documentColumnKeysExtension = createExtension(() => ({
  key: 'document-column-keys',
  runsBefore: ['document-table-keys'],
  keyboardShortcuts: {
    // A selection across columns goes through its own replace first, for
    // these and the word and line deletes alike (`document-table-keys.ts`).
    Backspace: ({ editor }: { editor: KeysEditor }) =>
      takeAwayColumnSpan(editor.prosemirrorView) || backspaceInColumn(editor.prosemirrorView),
    Delete: ({ editor }: { editor: KeysEditor }) =>
      takeAwayColumnSpan(editor.prosemirrorView) || deleteInColumn(editor.prosemirrorView),
    ...Object.fromEntries(
      [
        'Mod-Backspace',
        'Shift-Backspace',
        'Mod-Delete',
        'Ctrl-h',
        'Alt-Backspace',
        'Ctrl-d',
        'Ctrl-Alt-Backspace',
        'Alt-Delete',
        'Alt-d',
      ].map((key) => [key, ({ editor }: { editor: KeysEditor }) => takeAwayColumnSpan(editor.prosemirrorView)]),
    ),
  },
}));
