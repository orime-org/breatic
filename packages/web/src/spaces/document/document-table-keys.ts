// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The keys at and around tables: Tab, Shift-Tab, Enter and the arrows in a
 * cell; Backspace and Delete over every cell of an empty table, at the edges
 * of a cell and at the block beside a table; the arrows that open a line
 * beside a table at an end of the body; Backspace, Delete and the word and
 * line deletes over a selection holding a table whole (`takeAwayHeldTables`);
 * and every key that extends a selection (`EXTENDING`), which counts a table
 * as the one empty line the body would have (`extendAcrossTable`).
 *
 * A cell holds blocks the way the body does (inner#1619), so Enter and
 * Shift-Enter in a cell are the body's own. Tab in a list item nests it where
 * it can go in, Shift-Tab takes a nested one out; otherwise they move between
 * cells, and Tab in the last cell adds a row first — the way Google Docs,
 * Notion and Word answer it. Over several selected cells Enter does nothing.
 *
 * A stored table from before (`document-table-legacy.ts`) has no table role:
 * Enter and Shift-Enter break the line in its cell, Tab and Shift-Tab do
 * nothing there.
 *
 * Order matters in both directions. This runs ahead of `document-tab`, whose
 * Tab nests the block anywhere. `document-enter` runs ahead of this: its
 * input-method guard has to see the Enter that commits a composition, and it
 * declines the Enter over selected cells and in a stored table's cell. It also
 * runs ahead of `document-body-edge-selection`, so a selection key near a
 * table is answered here for a body-edge selection too.
 */

import { createExtension } from '@blocknote/core';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { BlockNoteEditor } from '@blocknote/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { squareSelectedTable } from '@web/spaces/document/document-table-nodes';
import { cellAt, wholeEmptyTableSelected } from '@web/spaces/document/document-table-run';
import {
  addRowAfter,
  cellAround,
  CellSelection,
  deleteCellSelection,
  goToNextCell,
  isInTable,
} from '@tiptap/pm/tables';
import { cellDepthOf, isTableCell, tableAround } from '@web/spaces/document/document-table-nodes';
import { inLegacyCell } from '@web/spaces/document/document-table-legacy';
import { heldTables, tableAtLeavingHead, tableEdgeText, takeAwayHeldTables } from '@web/spaces/document/document-table-leave-selection';
import { BodyEdgeSelection, bodyEdgeAt, bodyEdgeBetween, headOnEdgeLine, textOrEdge } from '@web/spaces/document/document-body-edge-selection';

/** The parts of the editor these bindings use. */
interface KeysEditor {
  readonly prosemirrorView: EditorView;
  removeBlocks: BlockNoteEditor<never, never, never>['removeBlocks'];
  insertBlocks: BlockNoteEditor<never, never, never>['insertBlocks'];
  setTextCursorPosition: BlockNoteEditor<never, never, never>['setTextCursorPosition'];
  canNestBlock: BlockNoteEditor<never, never, never>['canNestBlock'];
  nestBlock: BlockNoteEditor<never, never, never>['nestBlock'];
  unnestBlock: BlockNoteEditor<never, never, never>['unnestBlock'];
}

/** The list item types Tab nests before it moves between cells. */
const LIST_ITEMS = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);

/**
 * Whether the caret's block is a list item, and whether it is nested under
 * another block of its cell rather than standing at the cell's top.
 * @param $head - The caret.
 * @returns Whether it is a list item, and whether it is nested.
 */
function listItemAt($head: ResolvedPos): { list: boolean; nested: boolean } {
  const depth = containerDepth($head);
  if (depth < 0) return { list: false, nested: false };
  return {
    list: LIST_ITEMS.has($head.node(depth).firstChild?.type.name ?? ''),
    nested: $head.node(depth - 1).type.name === 'blockGroup',
  };
}

/**
 * Nests the list item the caret is in where it can go in; otherwise moves to
 * the next cell, adding a row first from the last cell.
 * @param editor - The editor.
 * @returns Whether the key was claimed.
 */
function tabForward(editor: KeysEditor): boolean {
  const view = editor.prosemirrorView;
  if (inLegacyCell(view.state.selection.$head)) return true;
  // A selection taking a table whole moves it as a block: the body's Tab.
  if (!isInTable(view.state) || heldTables(view.state.selection) !== null) return false;
  if (listItemAt(view.state.selection.$head).list && editor.canNestBlock()) {
    editor.nestBlock();
    return true;
  }
  if (goToNextCell(1)(view.state, view.dispatch)) return true;
  // A short row's missing cell, once evened, is the next cell.
  squareSelectedTable(view);
  if (!goToNextCell(1)(view.state, view.dispatch)) {
    addRowAfter(view.state, view.dispatch);
    goToNextCell(1)(view.state, view.dispatch);
  }
  return true;
}

/**
 * Takes a nested list item the caret is in out one level; otherwise moves to
 * the previous cell, and in the first cell the caret stays. A block at the top
 * of a cell never comes out of the cell.
 * @param editor - The editor.
 * @returns Whether the key was claimed.
 */
function tabBack(editor: KeysEditor): boolean {
  const view = editor.prosemirrorView;
  if (inLegacyCell(view.state.selection.$head)) return true;
  // A selection taking a table whole moves it as a block: the body's Tab.
  if (!isInTable(view.state) || heldTables(view.state.selection) !== null) return false;
  const item = listItemAt(view.state.selection.$head);
  if (item.list && item.nested) {
    editor.unnestBlock();
    return true;
  }
  goToNextCell(-1)(view.state, view.dispatch);
  return true;
}

/**
 * Enter and Shift-Enter where the body's own would be wrong: over several
 * selected cells they do nothing, and in a stored table's cell they break the
 * line. Everywhere else in a cell they are the body's.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function breakLine(view: EditorView): boolean {
  const { state } = view;
  if (state.selection instanceof CellSelection) return true;
  if (!inLegacyCell(state.selection.$head)) return false;
  const hardBreak = state.schema.nodes['hardBreak'];
  if (hardBreak === undefined) return false;
  view.dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  return true;
}

/**
 * The innermost block container around a position, and its depth.
 * @param $pos - The position.
 * @returns The depth, or -1 outside any block.
 */
function containerDepth($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'blockContainer') return depth;
  }
  return -1;
}

/**
 * The body's own first step for Backspace at the start of a block, which no
 * edge of a table changes: a heading or a list item turns into a paragraph,
 * which the body's Backspace does, and a quoted line loses its quote.
 * @param view - The editor view.
 * @param $head - The caret.
 * @param depth - The depth of the caret's block container.
 * @returns False to leave the key to the body, true once the quote is taken
 *   off, undefined for a plain paragraph.
 */
function firstStepAtStart(view: EditorView, $head: ResolvedPos, depth: number): boolean | undefined {
  const content = $head.node(depth).firstChild;
  if (content?.type.name !== 'paragraph') return false;
  if (content.attrs['quoted'] !== true) return undefined;
  view.dispatch(view.state.tr.setNodeMarkup($head.before(depth) + 1, undefined, { ...content.attrs, quoted: false }));
  return true;
}

/**
 * Backspace at the start of a block where the body's own would reach across
 * a cell's or a table's edge (design 5.3), after the body's own first step
 * ({@link firstStepAtStart}):
 *
 * - at the start of the paragraph that opens a cell it does nothing;
 * - at the start of the paragraph right under a table it moves the caret to
 *   the end of the table's last cell, and joins nothing.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function backspaceAtEdge(view: EditorView): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== 0) return false;
  const depth = containerDepth($head);
  if (depth < 0) return false;
  const parent = $head.node(depth - 1);
  const index = $head.index(depth - 1);
  if (isTableCell(parent) && index === 0) return firstStepAtStart(view, $head, depth) ?? true;
  if (cellDepthOf($head) > 0) return false;
  // What a selection can stand on before the block is in a table's cell only
  // when a table ends right before it: a divider or a picture between them is
  // a block of its own, which the body's Backspace takes.
  const inTable = Selection.findFrom(view.state.doc.resolve($head.before(depth)), -1);
  if (inTable === null || cellDepthOf(inTable.$head) < 0) return false;
  const step = firstStepAtStart(view, $head, depth);
  if (step !== undefined) return step;
  view.dispatch(view.state.tr.setSelection(inTable).scrollIntoView());
  return true;
}

/**
 * Delete at the end of a block where the body's own would reach across a
 * cell's or a table's edge (design 5.3): at the end of a cell's last block,
 * and at the end of the block right above a table, it does nothing.
 * @param view - The editor view.
 * @returns Whether the key was claimed.
 */
function deleteAtEdge(view: EditorView): boolean {
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $head } = selection;
  if ($head.parentOffset !== $head.parent.content.size) return false;
  const next = Selection.findFrom(doc.resolve($head.after()), 1);
  const cell = cellDepthOf($head);
  if (cell > 0) return next === null || next.from > $head.end(cell);
  // Outside a cell, what a selection can stand on next is in a cell only when
  // a table starts right after the block.
  return next !== null && cellDepthOf(next.$head) > 0;
}

/**
 * Clears selected cells through the table command, or removes the whole
 * table when every selected cell already holds one empty paragraph.
 * Cell selections are handled before individual block shortcuts.
 * @param editor - The editor.
 * @returns Whether the key was claimed.
 */
function deleteSelectedCells(editor: KeysEditor): boolean {
  const view = editor.prosemirrorView;
  const blockId = wholeEmptyTableSelected(view.state);
  if (blockId === null) return deleteCellSelection(view.state, view.dispatch);
  editor.removeBlocks([blockId]);
  return true;
}

/**
 * Collapses words selected in a cell to the end the arrow points at, the way
 * an arrow treats a selection everywhere else in the body. The table plugin's
 * own arrow leaves for the next cell whenever the selection's head is at the
 * cell's edge (`prosemirror-tables` `arrow`, `dist/index.js:2140-2143`), and the
 * words Tab and Shift-Tab select always reach both edges.
 * @param view - The editor view.
 * @param dir - -1 for left, 1 for right.
 * @returns Whether the key was claimed.
 */
function collapseInCell(view: EditorView, dir: -1 | 1): boolean {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || selection.empty || !isInTable(view.state)) return false;
  const at = dir < 0 ? selection.from : selection.to;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  return true;
}

/** Which arrow leaves a table, and on which side. */
type EdgeArrow = 'up' | 'down' | 'left' | 'right';

/**
 * Where a caret on its way out of a table leaves it: with no cell above it
 * going up or below it going down (the map's next cell skips the missing
 * cells of short rows), at the start of the first cell going left or the end
 * of the last going right in reading order, as Tab and the table plugin's own
 * horizontal arrow move — its block the cell's first or last at every
 * level down from the cell, a nested one included (`prosemirror-tables`
 * `atEndOfCell`), and on that line as far as the view says.
 * @param view - The editor view.
 * @param $head - The caret.
 * @param dir - Which arrow.
 * @returns The table's id and the position just outside the table that way, or null when the caret stays in it.
 */
function tableExit(view: EditorView, $head: ResolvedPos, dir: EdgeArrow): { blockId: string; edge: number } | null {
  const cell = cellAround($head);
  const at = cell === null ? null : cellAt(view.state.doc, cell.pos);
  if (cell === null || at === null) return null;
  const before = dir === 'up' || dir === 'left';
  let edgeLine = true;
  for (let d = $head.depth - 1; d > cell.depth; d -= 1) {
    if (before ? $head.index(d) !== 0 : $head.indexAfter(d) !== $head.node(d).childCount) edgeLine = false;
  }
  // Left and right read the table from the selection, the empty one
  // `leaveEdgeTable` holds when it asks about them.
  const edgeCell =
    dir === 'up' || dir === 'down'
      ? at.map.nextCell(cell.pos - at.tableStart, 'vert', before ? -1 : 1) === null
      : !goToNextCell(before ? -1 : 1)(view.state);
  const onEdgeLine = dir === 'up' || dir === 'down' ? headOnEdgeLine(view, $head.pos, dir === 'up' ? -1 : 1) : view.endOfTextblock(dir);
  if (!edgeLine || !edgeCell || !onEdgeLine) return null;
  return { blockId: at.blockId, edge: before ? cell.before(cell.depth - 1) : cell.after(cell.depth - 1) };
}

/**
 * Opens a line beside a table at an end of the body, when the caret is on its
 * way out of it (`tableExit`). Nothing past such a table can take a
 * selection, and the table plugin's own arrow falls back into the table
 * (`prosemirror-tables` `arrow`, `dist/index.js:2143-2151`). Under the table
 * this is the keyboard's way to the line a click on the space below the last
 * block opens; above it, to a line before a table the body starts with.
 * @param editor - The editor.
 * @param dir - Which arrow.
 * @returns Whether the key was claimed.
 */
function leaveEdgeTable(editor: KeysEditor, dir: EdgeArrow): boolean {
  const view = editor.prosemirrorView;
  const { selection } = view.state;
  const exit = selection.empty ? tableExit(view, selection.$head, dir) : null;
  if (exit === null) return false;
  const before = dir === 'up' || dir === 'left';
  // Past the table that way, anything a selection can stand on — a block
  // nested under the table, a divider — means the body goes on.
  if (Selection.findFrom(view.state.doc.resolve(exit.edge), before ? -1 : 1) !== null) return false;
  const [opened] = editor.insertBlocks([{ type: 'paragraph' }] as never, exit.blockId, before ? 'before' : 'after');
  if (opened === undefined) return false;
  editor.setTextCursorPosition(opened, 'start');
  return true;
}

/** How a key that extends a selection reaches past the line its head is on. */
type Reach =
  /** From the start or the end of the line's block. */
  | 'block'
  /** From the block's first or last line as drawn. */
  | 'line'
  /** Never: it stays on the line. */
  | null;

/** A key that extends a selection: which way, and how it reaches past a line. */
interface Extending {
  readonly back: boolean;
  readonly reach: Reach;
}

/**
 * Every key that extends a selection, the browser's own included. Shift with
 * Cmd and Up or Down (Ctrl outside macOS) moves the selected rows instead
 * (`document-keyboard-move.ts`).
 */
const EXTENDING: Readonly<Record<string, Extending>> = {
  'Shift-ArrowLeft': { back: true, reach: 'block' },
  'Shift-ArrowRight': { back: false, reach: 'block' },
  'Shift-ArrowUp': { back: true, reach: 'line' },
  'Shift-ArrowDown': { back: false, reach: 'line' },
  'Shift-Alt-ArrowLeft': { back: true, reach: 'block' },
  'Shift-Alt-ArrowRight': { back: false, reach: 'block' },
  'Shift-Alt-ArrowUp': { back: true, reach: 'block' },
  'Shift-Alt-ArrowDown': { back: false, reach: 'block' },
  'Shift-Ctrl-ArrowLeft': { back: true, reach: 'block' },
  'Shift-Ctrl-ArrowRight': { back: false, reach: 'block' },
  'Shift-Meta-ArrowLeft': { back: true, reach: null },
  'Shift-Meta-ArrowRight': { back: false, reach: null },
  'Shift-Home': { back: true, reach: null },
  'Shift-End': { back: false, reach: null },
};

/**
 * Where a key that extends a selection takes its head when a table is in
 * the way, a table counting as the one empty line the body would have in its
 * place (inner#1619 T14, design 5.3). The browser's own extension cannot step
 * into a table from the line beside it, moves an end standing in a table the
 * selection holds whole only within the table, where it is put back on the
 * table's edge, and prosemirror-tables' turns it into cells (`shiftArrow`).
 *
 * - An end standing in a table the selection holds whole goes over the whole
 *   table: to the nearest words past it, or the body's edge when only blocks
 *   without words are there. A table the body starts or ends with has that
 *   edge inside it, so the selection already holds all there is that way.
 * - An end on its way out of a table's first or last row (Up and Down) goes
 *   to the nearest words past the table, the whole table with it.
 * - An end on the edge of a line facing a table goes onto the table's words
 *   farthest away, which takes the whole table in.
 * - An end coming back into the table the other end stands in leaves a caret
 *   there: on the body's empty line both ends would meet.
 * @param view - The editor view.
 * @param key - The key.
 * @returns Whether the key was claimed.
 */
function extendAcrossTable(view: EditorView, key: Extending): boolean {
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) && !(selection instanceof BodyEdgeSelection)) return false;
  const { $head, anchor } = selection;
  const step = key.back ? -1 : 1;
  const own = tableAround(doc.resolve(anchor));
  /**
   * Puts the head somewhere, or a caret on the anchor when that is in the
   * anchor's own table.
   * @param head - Where the head goes.
   * @returns True.
   */
  const extendTo = (head: number): boolean => {
    // An edge of the body inside the anchor's table is where the end reaches
    // past that table, not a place in it.
    const meets = own !== null && bodyEdgeAt(doc, head) === null && head > own.pos && head < own.pos + own.node.nodeSize;
    view.dispatch(view.state.tr.setSelection(bodyEdgeBetween(doc, anchor, meets ? anchor : head)).scrollIntoView());
    return true;
  };
  const held = tableAtLeavingHead(view.state);
  if (held !== null) {
    const edge = key.back ? held.pos : held.pos + held.node.nodeSize;
    const past = textOrEdge(doc, edge, step);
    const within = past > held.pos && past < held.pos + held.node.nodeSize;
    return (past === edge || within) && own?.pos !== held.pos ? true : extendTo(past);
  }
  if (key.reach === null) return false;
  if (key.reach === 'line' && selection instanceof TextSelection) {
    const exit = tableExit(view, $head, key.back ? 'up' : 'down')?.edge;
    if (exit !== undefined) {
      const past = textOrEdge(doc, exit, step);
      return past !== exit && extendTo(past);
    }
  }
  const next = Selection.findFrom(doc.resolve(key.back ? $head.before() : $head.after()), step, true);
  const table = next === null ? null : tableAround(next.$head);
  if (table === null || table.pos === tableAround($head)?.pos) return false;
  // Measured only beside a table, so Up and Down everywhere else stay the
  // browser's own.
  const atEdge = key.reach === 'block'
    ? $head.parentOffset === (key.back ? 0 : $head.parent.content.size)
    : headOnEdgeLine(view, $head.pos, step);
  return atEdge && extendTo(tableEdgeText(doc, table, step));
}

/**
 * The extension that binds the keys inside a table.
 * @returns The extension, for the assembly to register.
 */
export const documentTableKeysExtension = createExtension(() => ({
  key: 'document-table-keys',
  runsBefore: ['document-tab'],
  keyboardShortcuts: {
    Tab: ({ editor }: { editor: KeysEditor }) => tabForward(editor),
    'Shift-Tab': ({ editor }: { editor: KeysEditor }) => tabBack(editor),
    // Enter over a selection holding a whole table is `document-enter`'s,
    // which takes it away first. Shift+Enter takes it away through its own
    // replace and then breaks the line at the caret it leaves: the body's
    // leaves the range and breaks at its head (BlockNote `handleEnter(true)`),
    // which here can be in a cell.
    Enter: ({ editor }: { editor: KeysEditor }) => breakLine(editor.prosemirrorView),
    'Shift-Enter': ({ editor }: { editor: KeysEditor }) => {
      takeAwayHeldTables(editor.prosemirrorView);
      return breakLine(editor.prosemirrorView);
    },
    // Over a selection holding a whole table, through the selection's own
    // replace (inner#1619 T14): the body's deletes the range by position.
    Backspace: ({ editor }: { editor: KeysEditor }) =>
      takeAwayHeldTables(editor.prosemirrorView) || deleteSelectedCells(editor) || backspaceAtEdge(editor.prosemirrorView),
    Delete: ({ editor }: { editor: KeysEditor }) =>
      takeAwayHeldTables(editor.prosemirrorView) || deleteSelectedCells(editor) || deleteAtEdge(editor.prosemirrorView),
    // The word and line deletes the body binds (Tiptap `keymap.ts:73-91`,
    // macOS ones included) delete the range by position as well.
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
      ].map((key) => [key, ({ editor }: { editor: KeysEditor }) => takeAwayHeldTables(editor.prosemirrorView)]),
    ),
    ArrowLeft: ({ editor }: { editor: KeysEditor }) =>
      collapseInCell(editor.prosemirrorView, -1) || leaveEdgeTable(editor, 'left'),
    ArrowRight: ({ editor }: { editor: KeysEditor }) =>
      collapseInCell(editor.prosemirrorView, 1) || leaveEdgeTable(editor, 'right'),
    ArrowUp: ({ editor }: { editor: KeysEditor }) => leaveEdgeTable(editor, 'up'),
    ArrowDown: ({ editor }: { editor: KeysEditor }) => leaveEdgeTable(editor, 'down'),
    ...Object.fromEntries(
      Object.entries(EXTENDING).map(([name, key]) => [
        name,
        ({ editor }: { editor: KeysEditor }) => extendAcrossTable(editor.prosemirrorView, key),
      ]),
    ),
  },
}) as never);
