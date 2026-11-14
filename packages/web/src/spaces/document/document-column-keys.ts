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
  const container = containerDepth($head);
  return container > 1 && $head.node(container - 1).type.name === DOC_COLUMN ? { depth: container - 1, container } : null;
}

/**
 * Deletes the caret's empty column and puts the caret beside where it stood;
 * a group left with one column dissolves by the repair rule, the caret
 * mapped through (`document-column-repair.ts`).
 * @param view - The editor view.
 * @param $head - The caret.
 * @param at - The caret's column.
 * @returns True once done.
 */
function deleteEmptyColumn(view: EditorView, $head: ResolvedPos, at: ColumnAt): boolean {
  const index = $head.index(at.depth - 1);
  const columnPos = $head.before(at.depth);
  const tr = view.state.tr.delete(columnPos, $head.after(at.depth));
  tr.setSelection(Selection.near(tr.doc.resolve(index === 0 ? columnPos : columnPos - 1), index === 0 ? 1 : -1));
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
  if (at !== null && holdsOneEmptyParagraph($head.node(at.depth))) return deleteEmptyColumn(view, $head, at);
  // Where what a selection can stand on next is in another column than the
  // caret's, or out of the caret's column, it does nothing, as at a cell's or
  // a table's edge (`deleteAtEdge`): at a column's end, and right above a group.
  const next = Selection.findFrom(doc.resolve($head.after()), 1);
  return (next === null ? null : columnAt(doc, next.from)) !== columnAt(doc, $head.pos);
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
