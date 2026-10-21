// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A selection with one end in a table and the other outside it takes the whole
 * table (inner#1619 T14), as Lexical (`$fixRangeSelectionForSelectedTable`) and
 * CKEditor 5 (its selection post-fixer) do: everything acting on such a
 * selection acts on the whole table.
 *
 * A ProseMirror selection's range has to stay where its ends are: the view
 * reads it back from the page while the pointer drags (prosemirror-view
 * `selectionFromDOM`, and our body-edge pointer from the selection's ends), and
 * a range set apart from them turns a drag into a caret. So the selection
 * keeps its ends on the table's first or last words (`TableSpanSelection`),
 * and what has to act on the whole table reads `heldRange`: the decoration
 * drawing every cell selected, copying (`document-table-copy.ts`), a drag's
 * content (`transformCopied`) and deleting.
 *
 * Deleting goes through `takeAwayHeldTables`: a `TableSpanSelection`'s own
 * replace deletes each table as a node and the part outside as text, so the
 * line the selection ends in stays, as it does in the body; a selection to an
 * edge of the body deletes `heldRange`. Inputs that delete the range by
 * position call it first: Backspace, Delete and Enter
 * (`document-table-keys.ts`), paste (`document-table-paste.ts`, ahead of the
 * table plugin's paste into cells), a typed key, an input method's
 * composition and the browser's own deletes (`beforeinput`).
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import {
  AllSelection,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { bodyEdgeAt } from '@web/spaces/document/document-body-edge-selection';
import { DOC_TABLE, isTableCell, tableAround, type TableAt } from '@web/spaces/document/document-table-nodes';

/** The class every cell of a table in such a selection carries. */
export const IN_SELECTION = 'doc-table-in-selection';

/**
 * The position after a table.
 * @param table - The table.
 * @returns The position.
 */
function endOf(table: TableAt): number {
  return table.pos + table.node.nodeSize;
}

/**
 * The tables around a text selection's two ends, when it leaves a table: one
 * end in a table and the other outside it or in another table.
 * @param selection - The selection.
 * @returns The table around the end towards the start and the one around the end towards the end, or null when it does not leave a table.
 */
function tablesAt(selection: Selection): { from: TableAt | null; to: TableAt | null } | null {
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const [$a, $b] = selection.anchor <= selection.head ? [selection.$anchor, selection.$head] : [selection.$head, selection.$anchor];
  const from = tableAround($a);
  const to = tableAround($b);
  if (from === null && to === null) return null;
  return from !== null && to !== null && from.pos === to.pos ? null : { from, to };
}

/** A selection leaving a table, its ends on the table's first or last words. */
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
   * Deletes the tables at the selection's ends as nodes and the part outside
   * them as text, and puts the caret where the end outside a table was.
   * @param tr - The transaction.
   * @returns The caret.
   */
  private takeAway(tr: Transaction): Selection {
    const { from, to } = this;
    const tables = tablesAt(this);
    const before = tables?.from ?? null;
    const after = tables?.to ?? null;
    const doc = tr.doc;
    const start = tr.steps.length;
    let caretAt: number;
    if (before !== null && after !== null) {
      tr.deleteRange(before.pos, endOf(after));
      caretAt = before.pos;
    } else if (before !== null) {
      // The words after the table up to the selection's end, then the table.
      const words = Selection.findFrom(doc.resolve(endOf(before)), 1, true)!.from;
      if (words < to) tr.delete(words, to);
      tr.deleteRange(before.pos, endOf(before));
      caretAt = words;
    } else {
      // The table, then the words before it from the selection's start.
      const words = Selection.findFrom(doc.resolve(after!.pos), -1, true)!.to;
      tr.deleteRange(after!.pos, endOf(after!));
      if (from < words) tr.delete(from, words);
      caretAt = from;
    }
    const caret = Selection.near(tr.doc.resolve(tr.mapping.slice(start).map(caretAt)), before !== null && after !== null ? -1 : 1);
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
function edgeOf(doc: PMNode, table: TableAt, dir: -1 | 1): number {
  // A selection's end in the table is such a place, so one is always found
  // inside the table.
  return dir < 0
    ? Selection.findFrom(doc.resolve(table.pos + 1), 1, true)!.from
    : Selection.findFrom(doc.resolve(endOf(table) - 1), -1, true)!.to;
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
export function tableAtLeavingHead(state: EditorState): TableAt | null {
  return tablesAt(state.selection) === null ? null : tableAround(state.selection.$head);
}

/**
 * What a selection with one end in a table and the other outside it acts on:
 * its range widened over each table one of its ends stands in. An end on an
 * edge of the body stands outside every table's content. Selections of cells,
 * of a node and of everything are their own.
 * @param selection - The selection.
 * @returns The range, or null when no end leaves a table.
 */
export function heldRange(selection: Selection): { from: number; to: number } | null {
  if (selection.empty || selection instanceof CellSelection || selection instanceof NodeSelection || selection instanceof AllSelection) {
    return null;
  }
  const doc = selection.$anchor.doc;
  /**
   * The table an end stands in.
   * @param pos - The end.
   * @returns The table, or null.
   */
  const around = (pos: number): TableAt | null => (bodyEdgeAt(doc, pos) === null ? tableAround(doc.resolve(pos)) : null);
  const start = Math.min(selection.anchor, selection.head);
  const end = Math.max(selection.anchor, selection.head);
  const first = around(start);
  const last = around(end);
  if (first === null && last === null) return null;
  if (first !== null && last !== null && first.pos === last.pos) return null;
  const tables = [first, last].filter((table): table is TableAt => table !== null);
  return { from: Math.min(start, ...tables.map((t) => t.pos)), to: Math.max(end, ...tables.map(endOf)) };
}

/**
 * Takes away a selection with one end in a table and the other outside it,
 * the table whole.
 * @param view - The editor view.
 * @returns Whether there was one to take away.
 */
export function takeAwayHeldTables(view: EditorView): boolean {
  const { selection } = view.state;
  if (selection instanceof TableSpanSelection) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    return true;
  }
  const range = heldRange(selection);
  if (range === null) return false;
  const tr = view.state.tr.deleteRange(range.from, range.to);
  tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(range.from, -1)), -1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Every cell of the tables a selection holds whole.
 * @param state - The editor state.
 * @returns The decorations.
 */
function cellsInSelection(state: EditorState): DecorationSet {
  const range = heldRange(state.selection);
  if (range === null) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  state.doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (node.type.name !== DOC_TABLE) return true;
    node.descendants((child, at) => {
      if (!isTableCell(child)) return true;
      const cellPos = pos + 1 + at;
      decorations.push(Decoration.node(cellPos, cellPos + child.nodeSize, { class: IN_SELECTION }));
      return false;
    });
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
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
          if (!(view.state.selection instanceof TableSpanSelection) && !takeAwayHeldTables(view)) return false;
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          return true;
        },
        // A drag of such a selection carries the whole table, which the drop
        // takes away (`tr.deleteSelection()`, the selection's own replace).
        transformCopied: (slice, view) => {
          const range = heldRange(view.state.selection);
          if (range === null || !slice.eq(view.state.selection.content())) return slice;
          return view.state.doc.slice(range.from, range.to);
        },
        handleDOMEvents: {
          compositionstart: (view) => {
            takeAwayHeldTables(view);
            return false;
          },
          beforeinput: (view, event) => {
            if (!event.inputType.startsWith('delete') || !takeAwayHeldTables(view)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    }),
  ],
}));
