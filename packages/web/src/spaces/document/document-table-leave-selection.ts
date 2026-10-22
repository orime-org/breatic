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
 * drawing every cell selected, copying (`document-table-copy.ts`) and a
 * drag's content (`transformCopied`).
 *
 * Deleting is the selection's own replace, `replaceHeld`, shared by
 * `TableSpanSelection` and the body-edge selection: each table it takes
 * becomes an empty line, and the selection then goes as the body's own does.
 * Cut, a drag's move and Enter (`document-enter.ts`) reach it through
 * `tr.deleteSelection()`, and a typed key through `tr.insertText`. Inputs that
 * would delete the range by position call it first through
 * `takeAwayHeldTables`: Backspace, Delete, the word and line deletes,
 * Shift+Enter (`document-table-keys.ts`), paste (`document-table-paste.ts`,
 * ahead of the table plugin's paste into cells), an input method's
 * composition and the browser's own deletes (`beforeinput`).
 */

import { createExtension } from '@blocknote/core';
import { Slice, type Node as PMNode } from '@tiptap/pm/model';
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

import { bodyEdgeAt, bodyEdgePos } from '@web/spaces/document/document-body-edge-pos';
import { DOC_TABLE, isTableCell, tableAround, type TableAt } from '@web/spaces/document/document-table-nodes';

/** The class every cell of a table in such a selection carries. */
export const IN_SELECTION = 'doc-table-in-selection';

/** The tables a selection takes whole: the one around each of its ends, if any. */
export interface HeldTables {
  /** Around the end towards the start. */
  readonly from: TableAt | null;
  /** Around the end towards the end. */
  readonly to: TableAt | null;
}

/**
 * The position after a table.
 * @param table - The table.
 * @returns The position.
 */
function endOf(table: TableAt): number {
  return table.pos + table.node.nodeSize;
}

/**
 * The tables a selection takes whole: one end in a table and the other
 * outside it, in another table, or on an edge of the body (which can lie in
 * a table the body starts or ends with). Selections of cells, of a node and
 * of everything are their own.
 * @param selection - The selection.
 * @returns The tables, or null when no end leaves a table.
 */
export function heldTables(selection: Selection): HeldTables | null {
  if (selection.empty || selection instanceof CellSelection || selection instanceof NodeSelection || selection instanceof AllSelection) {
    return null;
  }
  const doc = selection.$anchor.doc;
  const start = Math.min(selection.anchor, selection.head);
  const end = Math.max(selection.anchor, selection.head);
  const from = tableAround(doc.resolve(start));
  const to = tableAround(doc.resolve(end));
  if (from === null && to === null) return null;
  const onEdge = bodyEdgeAt(doc, start) !== null || bodyEdgeAt(doc, end) !== null;
  return from !== null && to !== null && from.pos === to.pos && !onEdge ? null : { from, to };
}

/**
 * What a selection that takes tables whole acts on: its range widened over
 * those tables.
 * @param selection - The selection.
 * @returns The range, or null when it takes no table whole.
 */
export function heldRange(selection: Selection): { from: number; to: number } | null {
  const tables = heldTables(selection);
  if (tables === null) return null;
  return {
    from: tables.from?.pos ?? Math.min(selection.anchor, selection.head),
    to: tables.to === null ? Math.max(selection.anchor, selection.head) : endOf(tables.to),
  };
}

/** Builds a selection of one kind between two positions. */
export type Rebuild = (doc: PMNode, anchor: number, head: number) => Selection;

/**
 * Replaces a selection that takes tables whole, the tables whole: what a
 * selection's own `replace` and `replaceWith` do for a selection leaving a
 * table and for one to an edge of the body. Each table it takes becomes an
 * empty line, its end in the table moves onto that line, and the selection
 * then goes the way the body's own does: the lines at its ends join, the
 * blocks between go, and an end on an edge of the body takes everything to
 * that edge.
 * @param selection - The selection.
 * @param tr - The transaction.
 * @param content - What goes in its place: a slice (`replace`), a node (`replaceWith`), or nothing.
 * @param rebuild - Builds a selection of the same kind on the changed document.
 * @returns Whether the selection took a table whole; false leaves it to the selection's usual replace.
 */
export function replaceHeld(selection: Selection, tr: Transaction, content: Slice | PMNode | undefined, rebuild: Rebuild): boolean {
  const tables = heldTables(selection);
  if (tables === null) return false;
  const doc = tr.doc;
  // The later table first, so the earlier one's position still holds.
  const held = [tables.to, tables.from?.pos === tables.to?.pos ? null : tables.from].filter((table): table is TableAt => table !== null);
  const steps = tr.steps.length;
  for (const table of held) tr.replaceWith(table.pos, endOf(table), doc.type.schema.nodes['blockContainer']!.createAndFill()!);
  const mapping = tr.mapping.slice(steps);
  /**
   * Where an end of the selection lands on the changed document.
   * @param pos - The end.
   * @returns The position.
   */
  const place = (pos: number): number => {
    const edge = bodyEdgeAt(doc, pos);
    if (edge !== null) return bodyEdgePos(tr.doc, edge);
    const table = held.find((t) => pos > t.pos && pos < endOf(t));
    // Inside the line that took the table's place: its block, then its words.
    return table === undefined ? mapping.map(pos) : mapping.map(table.pos, -1) + 2;
  };
  const rest = rebuild(tr.doc, place(selection.anchor), place(selection.head));
  if (content === undefined || content instanceof Slice) rest.replace(tr, content);
  else rest.replaceWith(tr, content);
  return true;
}

/**
 * A text selection between two positions.
 * @param doc - The document.
 * @param anchor - The anchor.
 * @param head - The head.
 * @returns The selection.
 */
const textBetween: Rebuild = (doc, anchor, head) => TextSelection.between(doc.resolve(anchor), doc.resolve(head));

/** A selection leaving a table, its ends on the table's first or last words. */
export class TableSpanSelection extends TextSelection {
  /**
   * Replaces the selection, the tables at its ends whole.
   * @param tr - The transaction.
   * @param content - What goes in its place.
   */
  override replace(tr: Transaction, content?: Slice): void {
    if (!replaceHeld(this, tr, content, textBetween)) super.replace(tr, content);
  }

  /**
   * Replaces the selection with a node, the tables at its ends whole.
   * @param tr - The transaction.
   * @param node - The node.
   */
  override replaceWith(tr: Transaction, node: PMNode): void {
    if (!replaceHeld(this, tr, node, textBetween)) super.replaceWith(tr, node);
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
 * The selection a text selection leaving a table becomes.
 * @param state - The editor state.
 * @returns The selection taking the whole table, or null when it is already so or does not leave a table.
 */
export function wholeTableSelection(state: EditorState): TableSpanSelection | null {
  const { selection, doc } = state;
  const tables = selection instanceof TextSelection ? heldTables(selection) : null;
  if (tables === null) return null;
  const from = tables.from === null ? selection.from : edgeOf(doc, tables.from, -1);
  const to = tables.to === null ? selection.to : edgeOf(doc, tables.to, 1);
  if (selection instanceof TableSpanSelection && from === selection.from && to === selection.to) return null;
  const [anchor, head] = selection.anchor <= selection.head ? [from, to] : [to, from];
  return new TableSpanSelection(doc.resolve(anchor), doc.resolve(head));
}

/**
 * The table around the selection's moving end, when the selection takes it whole.
 * @param state - The editor state.
 * @returns The table, or null.
 */
export function tableAtLeavingHead(state: EditorState): TableAt | null {
  return heldTables(state.selection) === null ? null : tableAround(state.selection.$head);
}

/**
 * Takes away a selection that takes tables whole, through the selection's own
 * replace, and leaves the caret where the selection started, as the body's
 * own deletes do (Tiptap's `deleteSelection`): the replace alone puts it past
 * what took the selection's place, the next line for one reaching the start
 * of the body.
 * @param view - The editor view.
 * @returns Whether there was one to take away.
 */
export function takeAwayHeldTables(view: EditorView): boolean {
  const { selection } = view.state;
  if (heldTables(selection) === null) return false;
  const tr = view.state.tr.deleteSelection();
  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(selection.from, -1))));
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
        // A typed key replaces the selection with its letter, through the
        // selection's own replace, as the body's typing does.
        handleTextInput: (view, _from, _to, text) => {
          if (heldTables(view.state.selection) === null) return false;
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
