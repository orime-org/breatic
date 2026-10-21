// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A selection with one end in a table and the other outside it takes the whole
 * table (inner#1619 T14), as Lexical (`$fixRangeSelectionForSelectedTable`) and
 * CKEditor 5 (its selection post-fixer) do: they move the selection to the
 * table's outside, so everything that reads the selection's range reads the
 * whole table.
 *
 * A ProseMirror text selection has to end in text, so the two are kept apart
 * here: a `TableSpanSelection` shows its ends on the table's first or last
 * words, and its range (`ranges`, so `from`, `to` and `content()`) runs over
 * the table node: from the position before it, to the position after its last
 * row, inside it, which BlockNote reads as the table (`getNearestBlockPos`;
 * the position after the table is the next block's). Copying, dragging and
 * anything that deletes the range as it is take the table whole. Its own replace deletes the table as a node
 * and the part outside as text, so the line the selection ends in stays, as
 * it does in the body.
 *
 * Inputs that would bypass that replace take the selection away through it
 * first (`takeAwayHeldTables`): Backspace, Delete and Enter
 * (`document-table-keys.ts`, ahead of the body's own, which delete the range
 * by position), paste (`document-table-paste.ts`, ahead of the table plugin's
 * paste into cells), a typed key, an input method's composition and the
 * browser's own deletes (`beforeinput`). A selection to an edge of the body
 * whose words end is in a table widens the same way
 * (`document-body-edge-selection.ts`).
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode, ResolvedPos, Slice } from '@tiptap/pm/model';
import {
  AllSelection,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  SelectionRange,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

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
 * The range a selection between two positions covers, widened over the
 * tables either of them stands in (inner#1619 T14).
 * @param doc - The document.
 * @param from - The position towards the start.
 * @param to - The position towards the end.
 * @param tables - The table around each, when it is in one.
 * @param tables.from - Around `from`.
 * @param tables.to - Around `to`.
 * @returns The range.
 */
export function rangeOverTables(
  doc: PMNode,
  from: number,
  to: number,
  tables: { readonly from: TableAt | null; readonly to: TableAt | null },
): SelectionRange {
  const start = tables.from === null ? from : Math.min(from, tables.from.pos);
  const end = tables.to === null ? to : Math.max(to, endOf(tables.to) - 1);
  return new SelectionRange(doc.resolve(start), doc.resolve(end));
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

/** A selection leaving a table: its range runs to the table node's edges. */
export class TableSpanSelection extends TextSelection {
  /**
   * Builds the selection, its range widened to the tables at its ends.
   * @param $anchor - The anchor, in text.
   * @param $head - The head, in text.
   */
  constructor($anchor: ResolvedPos, $head: ResolvedPos = $anchor) {
    super($anchor, $head);
    const { from, to } = this.textRange();
    const tables = tablesAt(this) ?? { from: null, to: null };
    (this as unknown as { ranges: SelectionRange[] }).ranges = [rangeOverTables($anchor.doc, from, to, tables)];
  }

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
   * The selection's ends in text, in document order.
   * @returns The two positions.
   */
  private textRange(): { from: number; to: number } {
    return { from: Math.min(this.anchor, this.head), to: Math.max(this.anchor, this.head) };
  }

  /**
   * Deletes the tables at the selection's ends as nodes and the part outside
   * them as text, and puts the caret where the end outside a table was.
   * @param tr - The transaction.
   * @returns The caret.
   */
  private takeAway(tr: Transaction): Selection {
    const { from, to } = this.textRange();
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
  const forward = selection.anchor <= selection.head;
  const start = Math.min(selection.anchor, selection.head);
  const end = Math.max(selection.anchor, selection.head);
  const from = tables.from === null ? start : edgeOf(doc, tables.from, -1);
  const to = tables.to === null ? end : edgeOf(doc, tables.to, 1);
  if (selection instanceof TableSpanSelection && from === start && to === end) return null;
  const [anchor, head] = forward ? [from, to] : [to, from];
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
 * Whether a selection takes a whole table because one of its ends is in it:
 * its range holds the table one end stands in. Selections of cells, of a node
 * and of everything are their own.
 * @param selection - The selection.
 * @returns True when it does.
 */
export function holdsWholeTable(selection: Selection): boolean {
  if (selection.empty || selection instanceof CellSelection || selection instanceof NodeSelection || selection instanceof AllSelection) {
    return false;
  }
  return [selection.$anchor, selection.$head].some(($end) => {
    const table = tableAround($end);
    return table !== null && table.pos >= selection.from && endOf(table) - 1 <= selection.to;
  });
}

/**
 * Takes away a selection that holds a whole table, through the selection's
 * own replace.
 * @param view - The editor view.
 * @returns Whether there was one to take away.
 */
export function takeAwayHeldTables(view: EditorView): boolean {
  if (!holdsWholeTable(view.state.selection)) return false;
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  return true;
}

/**
 * Every cell of the tables a selection holds whole.
 * @param state - The editor state.
 * @returns The decorations.
 */
function cellsInSelection(state: EditorState): DecorationSet {
  const { selection, doc } = state;
  if (!holdsWholeTable(selection)) return DecorationSet.empty;
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
          if (!holdsWholeTable(view.state.selection)) return false;
          view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          return true;
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
