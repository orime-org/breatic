// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A selection with one end in a table and the other outside it takes the whole
 * table (inner#1619 T14), as Lexical (`$fixRangeSelectionForSelectedTable`) and
 * CKEditor 5 (its selection post-fixer) do: the end in the table moves to the
 * table's first or last place a caret can stand, every cell is drawn
 * selected, and whatever replaces the selection takes the table away whole.
 *
 * The selection is a `TableSpanSelection`, whose replace deletes from the
 * table's own edge, so deleting, cutting, pasting and typing (which all go
 * through `Selection.replace` or `replaceWith`) never cut a table, whichever
 * blocks the table starts or ends with. A typed key and an input method's
 * composition reach ProseMirror with positions of their own, which would
 * bypass the selection, so both go through it first.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode, ResolvedPos, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { DOC_TABLE, isTableCell } from '@web/spaces/document/document-table-nodes';

/** The class every cell of a table in such a selection carries. */
export const IN_SELECTION = 'doc-table-in-selection';

/** A table and the position before it. */
export interface Table {
  readonly pos: number;
  readonly node: PMNode;
}

/**
 * The table around a position; tables do not nest.
 * @param $pos - The position.
 * @returns The table, or null outside any.
 */
export function tableAround($pos: ResolvedPos): Table | null {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type.name === DOC_TABLE) return { pos: $pos.before(depth), node: $pos.node(depth) };
  }
  return null;
}

/**
 * The tables around a selection's two ends, when it leaves a table: one end
 * in a table and the other outside it or in another table.
 * @param selection - The selection.
 * @returns The table around each end, or null when it does not leave a table.
 */
function tablesAt(selection: Selection): { from: Table | null; to: Table | null } | null {
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const from = tableAround(selection.$from);
  const to = tableAround(selection.$to);
  if (from === null && to === null) return null;
  return from !== null && to !== null && from.pos === to.pos ? null : { from, to };
}

/** A selection leaving a table: replacing it deletes from the table's own edge. */
export class TableSpanSelection extends TextSelection {
  /**
   * Replaces the selection, the tables at its ends whole.
   * @param tr - The transaction.
   * @param content - What goes in its place.
   */
  override replace(tr: Transaction, content?: Slice): void {
    const caret = this.takeAway(tr);
    if (content !== undefined && content.size > 0) caret.replace(tr, content);
  }

  /**
   * Replaces the selection with a node, the tables at its ends whole.
   * @param tr - The transaction.
   * @param node - The node.
   */
  override replaceWith(tr: Transaction, node: PMNode): void {
    this.takeAway(tr).replaceWith(tr, node);
  }

  /**
   * Deletes the selection from the edges of the tables at its ends, and puts
   * the caret where an end outside a table was.
   * @param tr - The transaction.
   * @returns The caret.
   */
  private takeAway(tr: Transaction): Selection {
    const tables = tablesAt(this);
    const before = tables?.from ?? null;
    const after = tables?.to ?? null;
    const from = before === null ? this.from : before.pos;
    const to = after === null ? this.to : after.pos + after.node.nodeSize;
    const start = tr.steps.length;
    tr.deleteRange(from, to);
    const mapping = tr.mapping.slice(start);
    const caret = before === null
      ? Selection.near(tr.doc.resolve(mapping.map(from, -1)), -1)
      : Selection.near(tr.doc.resolve(mapping.map(to, 1)), after === null ? 1 : -1);
    tr.setSelection(caret);
    return caret;
  }
}

/**
 * The first (towards the start) or last (towards the end) place in a table a
 * caret can stand.
 * @param doc - The document.
 * @param table - The table.
 * @param dir - -1 for the end towards the start, 1 for the end towards the end.
 * @returns The position.
 */
function edgeOf(doc: PMNode, table: Table, dir: -1 | 1): number {
  // A selection's end in the table is such a place, so one is always found
  // inside the table.
  return dir < 0
    ? Selection.findFrom(doc.resolve(table.pos + 1), 1, true)!.from
    : Selection.findFrom(doc.resolve(table.pos + table.node.nodeSize - 1), -1, true)!.to;
}

/**
 * The selection a selection leaving a table becomes.
 * @param state - The editor state.
 * @returns The selection taking the whole table, or null when it is already so or does not leave a table.
 */
export function wholeTableSelection(state: EditorState): TableSpanSelection | null {
  const { selection, doc } = state;
  const tables = tablesAt(selection);
  if (tables === null) return null;
  const from = tables.from === null ? selection.from : edgeOf(doc, tables.from, -1);
  const to = tables.to === null ? selection.to : edgeOf(doc, tables.to, 1);
  if (selection instanceof TableSpanSelection && from === selection.from && to === selection.to) return null;
  const [anchor, head] = selection.anchor <= selection.head ? [from, to] : [to, from];
  return new TableSpanSelection(doc.resolve(anchor), doc.resolve(head));
}

/**
 * The table around the selection's moving end, when the selection leaves a table.
 * @param state - The editor state.
 * @returns The table, or null.
 */
export function tableAtLeavingHead(state: EditorState): Table | null {
  return tablesAt(state.selection) === null ? null : tableAround(state.selection.$head);
}

/**
 * Every cell of the tables a selection runs into or over, unless both its
 * ends are in one table, which draws its own cell selection.
 * @param state - The editor state.
 * @returns The decorations.
 */
function cellsInSelection(state: EditorState): DecorationSet {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return DecorationSet.empty;
  const atFrom = tableAround(selection.$from);
  if (atFrom !== null && atFrom.pos === tableAround(selection.$to)?.pos) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.type.name !== DOC_TABLE) return true;
    node.descendants((child, at) => {
      if (!isTableCell(child)) return true;
      const cellPos = pos + 1 + at;
      decorations.push(Decoration.node(cellPos, cellPos + child.nodeSize, { class: IN_SELECTION }));
      return false;
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The extension.
 * @returns The extension, for the assembly to register.
 */
export const documentTableLeaveSelectionExtension = createExtension(() => ({
  key: 'documentTableLeaveSelection',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentTableLeaveSelection'),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
        const whole = wholeTableSelection(state);
        return whole === null ? null : state.tr.setSelection(whole);
      },
      props: {
        decorations: cellsInSelection,
        handleTextInput: (view, _from, _to, text) => {
          if (!(view.state.selection instanceof TableSpanSelection)) return false;
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          compositionstart: (view) => {
            if (view.state.selection instanceof TableSpanSelection) view.dispatch(view.state.tr.deleteSelection());
            return false;
          },
        },
      },
    }),
  ],
}));
