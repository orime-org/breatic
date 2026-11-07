// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A text selection covering every block of one table cell keeps the cell when
 * it is replaced (inner#1351 design §5.4.6 "cell structure"; inner#1619 T6).
 *
 * ProseMirror's `deleteRange` widens a range covering several blocks that fill
 * a node to the node itself, when its parent allows it to go: a row allows a
 * cell to go, so the cell would leave its row and the cells after it would
 * shift a column. Every key, cut, drag, paste and typed letter replaces the
 * selection through its own `replace` or `replaceWith`, so a selection of this
 * class empties the cell to one empty paragraph and puts what replaces it
 * there, the way `TableSpanSelection` keeps tables whole
 * (`document-table-leave-selection.ts`). The delete keys, Enter, an input
 * method's composition and the browser's own deletes take such a selection
 * away through its replace first (`takeAwayCellContent`): the body's own
 * delete removes the range by position (`@tiptap/core` `deleteSelection`).
 */

import { createExtension } from '@blocknote/core';
import { Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { cellDepthOf } from '@web/spaces/document/document-table-nodes';

/**
 * The content of the one cell a selection covers every block of, when
 * taking it away would take the cell out of its row: a text selection over
 * more than one textblock of the cell, its ends at the first and last places
 * a selection can stand in the cell, a picture or a divider included.
 * @param selection - The selection.
 * @returns The cell's content range, or null for any other selection.
 */
export function wholeCellContent(selection: Selection): { start: number; end: number } | null {
  const { $from, $to } = selection;
  if (!(selection instanceof TextSelection) || selection.empty || $from.sameParent($to)) return null;
  const depth = cellDepthOf($from);
  if (depth < 0 || $to.depth < depth || $to.node(depth) !== $from.node(depth)) return null;
  const start = $from.start(depth);
  const end = $from.end(depth);
  const doc = $from.doc;
  const covers = Selection.findFrom(doc.resolve(start), 1)?.from === selection.from && Selection.findFrom(doc.resolve(end), -1)?.to === selection.to;
  return covers ? { start, end } : null;
}

/** A text selection covering every block of one cell. */
class CellContentSelection extends TextSelection {
  /**
   * Empties the cell to one empty paragraph and returns the caret in it.
   * @param tr - The transaction.
   * @returns The caret in the emptied cell.
   */
  private emptied(tr: Transaction): Selection {
    const cell = wholeCellContent(this);
    // The schema refills the emptied cell with an empty paragraph.
    if (cell !== null) tr.delete(tr.mapping.map(cell.start), tr.mapping.map(cell.end));
    const start = tr.mapping.map(cell?.start ?? this.from);
    return TextSelection.near(tr.doc.resolve(start));
  }

  /**
   * Replaces the selection, the cell kept.
   * @param tr - The transaction.
   * @param content - What goes in its place.
   */
  override replace(tr: Transaction, content: Slice = Slice.empty): void {
    const caret = this.emptied(tr);
    tr.setSelection(caret);
    if (content.size > 0) caret.replace(tr, content);
  }

  /**
   * Replaces the selection with a node, the cell kept.
   * @param tr - The transaction.
   * @param node - The node.
   */
  override replaceWith(tr: Transaction, node: PMNode): void {
    const caret = this.emptied(tr);
    tr.setSelection(caret);
    caret.replaceWith(tr, node);
  }
}

/**
 * Whether a selection is one covering every block of one cell.
 * @param selection - The selection.
 * @returns True for such a selection.
 */
export function holdsWholeCell(selection: Selection): boolean {
  return selection instanceof CellContentSelection;
}

/**
 * Takes away a selection covering every block of one cell through its own
 * replace, leaving the caret in the emptied cell.
 * @param view - The editor view.
 * @returns True when it was such a selection.
 */
export function takeAwayCellContent(view: EditorView): boolean {
  if (!holdsWholeCell(view.state.selection)) return false;
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  return true;
}

/**
 * The extension that turns a text selection covering every block of one cell
 * into a `CellContentSelection`.
 * @returns The extension, for the assembly to register.
 */
export const documentCellContentSelectionExtension = createExtension(() => ({
  key: 'documentCellContentSelection',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentCellContentSelection'),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
        const { selection } = state;
        if (selection instanceof CellContentSelection || wholeCellContent(selection) === null) return null;
        return state.tr.setSelection(new CellContentSelection(selection.$anchor, selection.$head));
      },
      props: {
        handleDOMEvents: {
          compositionstart: (view) => {
            takeAwayCellContent(view);
            return false;
          },
          beforeinput: (view, event) => {
            if (!event.inputType.startsWith('delete') || !takeAwayCellContent(view)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    }),
  ],
}));
