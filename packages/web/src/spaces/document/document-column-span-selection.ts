// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A text selection whose ends stand in different columns, or one in a column
 * and the other outside its group (inner#1314 design §5.5). Replacing it
 * (a delete, a cut, typing, a paste, a drag's move) never runs words from one
 * column into another: each column keeps what was not selected in it, as a
 * cell does (`takeAwayCellContent`); a column the selection covers from its
 * first word to its last goes whole, and the repair rule
 * (`document-column-repair.ts`) dissolves a group left with one column. What
 * goes in lands where the selection started, or where it ended when the start
 * went with a whole column.
 *
 * The selection keeps its ends where they are, as `TableSpanSelection` does,
 * and only its replace differs; a plugin turns a text selection that runs
 * across columns into one after every change. Typing reaches the replace
 * through `tr.insertText(text)`, and an input method's composition and the
 * browser's own deletes take the selection away first, as the table's leave
 * selection does.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-geometry';
import { heldRange, heldTables, TableSpanSelection, tableEdgeText } from '@web/spaces/document/document-table-leave-selection';

/** A range taken out of the document. */
interface Piece {
  readonly from: number;
  readonly to: number;
  /** Whether it is the whole column the selection starts in, which goes with it. */
  readonly startGoes: boolean;
}

/**
 * The id of the innermost column around a position.
 * @param doc - The document.
 * @param pos - The position.
 * @returns The id, or null outside any column.
 */
export function columnAt(doc: PMNode, pos: number): string | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === DOC_COLUMN) return String(node.attrs['id']);
  }
  return null;
}

/**
 * Whether a selection's ends stand in different columns, or one in a column
 * and the other outside it.
 * @param selection - The selection.
 * @returns True when it runs across columns.
 */
function spansColumns(selection: Selection): boolean {
  if (selection.empty || !(selection instanceof TextSelection)) return false;
  const doc = selection.$from.doc;
  return columnAt(doc, selection.from) !== columnAt(doc, selection.to);
}

/**
 * The pieces a selection across columns takes away, in document order: the
 * selected part of each column it starts or ends in, each column it covers
 * whole, and the body's words around the groups. A group left with one column
 * or none goes by the repair rule.
 * @param doc - The document.
 * @param from - The selection's start.
 * @param to - The selection's end.
 * @returns The pieces.
 */
function piecesOf(doc: PMNode, from: number, to: number): Piece[] {
  const pieces: Piece[] = [];
  let cursor = from;
  /**
   * Takes the body's words from the cursor to a position.
   * @param end - The position.
   */
  const bodyTo = (end: number): void => {
    if (end > cursor) pieces.push({ from: cursor, to: end, startGoes: false });
  };
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== DOC_COLUMN_LIST || pos + node.nodeSize <= from || pos >= to) return true;
    const groupEnd = pos + node.nodeSize;
    const parts: Piece[] = [];
    node.forEach((column, offset) => {
      const start = pos + 1 + offset;
      const end = start + column.nodeSize;
      if (end <= from || start >= to) return;
      // Its first and last content, a picture or a divider as much as words.
      const first = Selection.findFrom(doc.resolve(start + 1), 1)?.from ?? start + 1;
      const last = Selection.findFrom(doc.resolve(end - 1), -1)?.to ?? end - 1;
      if (from <= first && to >= last) parts.push({ from: start, to: end, startGoes: from > start });
      else if (from > start) parts.push({ from, to: end - 1, startGoes: false });
      else parts.push({ from: start + 1, to, startGoes: false });
    });
    bodyTo(Math.min(pos, to));
    pieces.push(...parts);
    cursor = Math.max(cursor, Math.min(groupEnd, to));
    return false;
  });
  bodyTo(to);
  return pieces;
}

/**
 * Takes a selection across columns away and puts content in its place.
 * @param selection - The selection.
 * @param tr - The transaction.
 * @param put - Puts the content at a position, or nothing.
 */
function replaceAcross(selection: Selection, tr: Transaction, put: ((at: number) => void) | null): void {
  // A table at an end goes whole, as a selection leaving a table takes it.
  const range = heldRange(selection) ?? selection;
  const pieces = piecesOf(tr.doc, range.from, range.to);
  const startGoes = pieces[0]?.startGoes === true;
  const first = tr.steps.length;
  for (const piece of [...pieces].reverse()) tr.delete(piece.from, piece.to);
  const after = tr.mapping.slice(first);
  const at = startGoes ? after.map(selection.to, -1) : after.map(selection.from, -1);
  const placed = tr.steps.length;
  put?.(at);
  let end = at;
  tr.mapping.slice(placed).maps.forEach((map) => map.forEach((_from, _to, _newFrom, newTo) => (end = newTo)));
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
}

/** A text selection across columns. */
export class ColumnSpanSelection extends TextSelection {
  /**
   * Replaces the selection, column by column.
   * @param tr - The transaction.
   * @param content - What goes in its place.
   */
  override replace(tr: Transaction, content?: Slice): void {
    replaceAcross(this, tr, content === undefined || content.size === 0 ? null : (at) => tr.replaceRange(at, at, content));
  }

  /**
   * Replaces the selection with a node, column by column.
   * @param tr - The transaction.
   * @param node - The node.
   */
  override replaceWith(tr: Transaction, node: PMNode): void {
    replaceAcross(this, tr, (at) => tr.replaceRangeWith(at, at, node));
  }

  /**
   * This selection with its ends in the tables it takes whole moved onto
   * those tables' outer words, as a selection leaving a table has them
   * (`document-table-leave-selection.ts`).
   * @returns It, or null when its ends are there already.
   */
  wholeTables(): Selection | null {
    const tables = heldTables(this);
    if (tables === null) return null;
    const doc = this.$anchor.doc;
    const from = tables.from === null ? this.from : tableEdgeText(doc, tables.from, -1);
    const to = tables.to === null ? this.to : tableEdgeText(doc, tables.to, 1);
    if (from === this.from && to === this.to) return null;
    const [anchor, head] = this.anchor <= this.head ? [from, to] : [to, from];
    return new ColumnSpanSelection(doc.resolve(anchor), doc.resolve(head));
  }
}

/**
 * The selection a text selection across columns becomes.
 * @param state - The editor state.
 * @returns It, or null when it is already one or runs across no columns.
 */
function columnSpanSelection(state: EditorState): Selection | null {
  const { selection } = state;
  // A plain text selection, or a table's leave selection whose ends stand in
  // different columns; one already across columns and a body-edge selection
  // keep their own kind.
  const plain = Object.getPrototypeOf(selection) === TextSelection.prototype || selection instanceof TableSpanSelection;
  if (!plain || !spansColumns(selection)) return null;
  return new ColumnSpanSelection(selection.$anchor, selection.$head);
}

/**
 * Takes a selection across columns away, through its own replace: the
 * body's deletes take a range by position.
 * @param view - The editor view.
 * @returns Whether there was one.
 */
export function takeAwayColumnSpan(view: EditorView): boolean {
  if (!(view.state.selection instanceof ColumnSpanSelection)) return false;
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  return true;
}

/**
 * The extension.
 * @returns The extension, for the assembly to register.
 */
export const documentColumnSpanSelectionExtension = createExtension(() => ({
  key: 'document-column-span-selection',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentColumnSpanSelection'),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
        const span = columnSpanSelection(state);
        return span === null ? null : state.tr.setSelection(span);
      },
      props: {
        handleTextInput: (view, _from, _to, text) => {
          if (!(view.state.selection instanceof ColumnSpanSelection)) return false;
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          compositionstart: (view) => {
            takeAwayColumnSpan(view);
            return false;
          },
          beforeinput: (view, event) => {
            if (!event.inputType.startsWith('delete') || !takeAwayColumnSpan(view)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    }),
  ],
}));
