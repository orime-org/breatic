// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A selection with one end in a table and the other outside it takes the whole
 * table (inner#1619 T14), as Lexical (`$fixRangeSelectionForSelectedTable`) and
 * CKEditor 5 (its selection post-fixer) do: the end in the table moves to the
 * table's edge on its side, every cell is drawn selected, and typing or
 * deleting over it takes the table away whole.
 *
 * The end moves to the first or last words of the table, which ProseMirror's
 * own replace treats as covering the table whole (`replaceRange` drops a
 * parent covered from its start); when the table does not begin or end with
 * words, it moves to the nearest words outside the table instead. A typed
 * key and an input method's composition insert text with a plain replace,
 * which would cut the table, so both take the selection away first.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { DOC_TABLE, isTableCell } from '@web/spaces/document/document-table-nodes';

/** The class every cell of a table in such a selection carries. */
export const IN_SELECTION = 'doc-table-in-selection';

/** A table and the position before it. */
interface Table {
  readonly pos: number;
  readonly node: PMNode;
}

/**
 * The table around a position; tables do not nest.
 * @param $pos - The position.
 * @returns The table, or null outside any.
 */
function tableAround($pos: ResolvedPos): Table | null {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type.name === DOC_TABLE) return { pos: $pos.before(depth), node: $pos.node(depth) };
  }
  return null;
}

/**
 * Where an end of a selection in a table goes to take the whole table: the
 * table's first words (towards the start) or last words (towards the end),
 * or, when something other than words comes first there, the nearest words
 * outside the table on that side.
 * @param doc - The document.
 * @param table - The table.
 * @param dir - -1 for the end towards the start, 1 for the end towards the end.
 * @returns The position.
 */
function edgeOf(doc: PMNode, table: Table, dir: -1 | 1): number {
  const start = table.pos + 1;
  const end = table.pos + table.node.nodeSize - 1;
  const words = dir < 0 ? Selection.findFrom(doc.resolve(start), 1, true) : Selection.findFrom(doc.resolve(end), -1, true);
  let other = false;
  if (words !== null) {
    const [from, to] = dir < 0 ? [start, words.from] : [words.to, end];
    doc.nodesBetween(from, to, (node) => {
      if (node.isLeaf && !node.isText) other = true;
      return !other;
    });
  }
  if (words !== null && !other) return dir < 0 ? words.from : words.to;
  const outside = dir < 0 ? Selection.findFrom(doc.resolve(table.pos), -1, true) : Selection.findFrom(doc.resolve(table.pos + table.node.nodeSize), 1, true);
  if (outside !== null) return dir < 0 ? outside.to : outside.from;
  return dir < 0 ? (words?.from ?? start) : (words?.to ?? end);
}

/**
 * The selection a selection leaving a table becomes.
 * @param state - The editor state.
 * @returns The selection taking the whole table, or null when it is already so or does not leave a table.
 */
export function wholeTableSelection(state: EditorState): TextSelection | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const atFrom = tableAround(selection.$from);
  const atTo = tableAround(selection.$to);
  if (atFrom !== null && atTo !== null && atFrom.pos === atTo.pos) return null;
  const from = atFrom === null ? selection.from : edgeOf(doc, atFrom, -1);
  const to = atTo === null ? selection.to : edgeOf(doc, atTo, 1);
  if (from === selection.from && to === selection.to) return null;
  return selection.anchor <= selection.head ? TextSelection.create(doc, from, to) : TextSelection.create(doc, to, from);
}

/**
 * Whether the selection has one end in a table and the other outside it.
 * @param state - The editor state.
 * @returns True when it does.
 */
function leavesTable(state: EditorState): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return false;
  const atFrom = tableAround(selection.$from);
  const atTo = tableAround(selection.$to);
  return (atFrom !== null || atTo !== null) && atFrom?.pos !== atTo?.pos;
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
 * Takes a selection leaving a table away, table and all.
 * @param view - The editor view.
 */
function takeAway(view: EditorView): void {
  view.dispatch(view.state.tr.deleteSelection());
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
          if (!leavesTable(view.state)) return false;
          view.dispatch(view.state.tr.deleteSelection().insertText(text).scrollIntoView());
          return true;
        },
        handleDOMEvents: {
          compositionstart: (view) => {
            if (leavesTable(view.state)) takeAway(view);
            return false;
          },
        },
      },
    }),
  ],
}));
