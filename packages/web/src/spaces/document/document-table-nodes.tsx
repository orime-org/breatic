// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The table, as four layout blocks whose cells hold blocks (inner#1619):
 * `docTable > docTableRow > docTableCell | docTableHeader > blocks`.
 *
 * - Rows and cells draw native frames (`<tr>`, `<td>`, `<th>`): a React
 *   frame's view is wrapped in a `display: contents` element
 *   (`ReactBlockSpec.tsx:477`), and prosemirror-tables' `selectedCell`
 *   decoration would land on the wrapper instead of the cell.
 * - The table frame sits in the horizontal frame of `DocumentTableScroller`
 *   and draws its `<colgroup>` from the first row the way
 *   prosemirror-tables' `updateColumnsOnResize` does, which column resizing
 *   then drives during a drag.
 * - `docTable` keeps `dissolve: false`: `fixLayoutBlock` otherwise reads a row
 *   left with one empty cell as an empty row and takes the table apart.
 * - Rows allow no cells (`min: 0`): a row every cell of which is covered by a
 *   cell spanning down from above has none of its own (upstream #1993).
 * - Cells exclude `docTable`; a table never goes inside a cell.
 */

import { addNodeAndExtensionsToSpec, createBlockSpec, createExtension } from '@blocknote/core';
import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import {
  __pastedCells as pastedCells,
  cellAround,
  CellSelection,
  columnIsHeader,
  columnResizing,
  fixTables,
  rowIsHeader,
  fixTablesKey,
  TableMap,
  tableEditing,
} from '@tiptap/pm/tables';
import { ReplaceStep, type Step } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { createRoot, type Root } from 'react-dom/client';

import { DocumentTableScroller } from '@web/spaces/document/DocumentTableScroller';
import { heldTables } from '@web/spaces/document/document-table-leave-selection';

/** The narrowest a column can be dragged. */
const CELL_MIN_WIDTH = 35;

/** The width a column without a stored width counts as. */
export const DEFAULT_CELL_WIDTH = 120;

/**
 * How far either side of a column's line the pointer picks up its width
 * (prosemirror-tables `handleWidth`); a block's handle in the next cell keeps
 * clear of it.
 */
export const COLUMN_RESIZE_ZONE = 5;

/** The table's block types. */
export const DOC_TABLE = 'docTable';
export const DOC_TABLE_ROW = 'docTableRow';
export const DOC_TABLE_CELL = 'docTableCell';
export const DOC_TABLE_HEADER = 'docTableHeader';

/** The prosemirror-tables role of each table node. */
const TABLE_ROLES: Readonly<Record<string, string>> = {
  [DOC_TABLE]: 'table',
  [DOC_TABLE_ROW]: 'row',
  [DOC_TABLE_CELL]: 'cell',
  [DOC_TABLE_HEADER]: 'header_cell',
};

/**
 * Whether a node is a table cell, a header cell included.
 * @param node - The node.
 * @returns True for a cell.
 */
export function isTableCell(node: PMNode): boolean {
  const role = node.type.spec['tableRole'];
  return role === 'cell' || role === 'header_cell';
}

/**
 * Whether a node holds blocks as a body does: a block group or a table cell.
 * @param node - The node.
 * @returns True for either.
 */
export function holdsBlocks(node: PMNode): boolean {
  return node.type.name === 'blockGroup' || isTableCell(node);
}

/**
 * The innermost table cell around a position.
 * @param $pos - The position.
 * @returns The cell's depth, or -1 outside any cell.
 */
export function cellDepthOf($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (isTableCell($pos.node(depth))) return depth;
  }
  return -1;
}

/** A table and the position before it. */
export interface TableAt {
  readonly pos: number;
  readonly node: PMNode;
}

/**
 * The table around a position; tables do not nest.
 * @param $pos - The position.
 * @returns The table, or null outside any.
 */
export function tableAround($pos: ResolvedPos): TableAt | null {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type.name === DOC_TABLE) return { pos: $pos.before(depth), node: $pos.node(depth) };
  }
  return null;
}

/**
 * Whether the block a block id names stands in a table cell.
 * @param doc - The document.
 * @param blockId - The block.
 * @returns True when a cell holds it, nested blocks included.
 */
export function blockInTableCell(doc: PMNode, blockId: string): boolean {
  let inCell = false;
  doc.descendants((node, pos) => {
    if (node.attrs['id'] !== blockId) return !inCell;
    inCell = cellDepthOf(doc.resolve(pos)) > 0;
    return false;
  });
  return inCell;
}

/** A cell's props. */
interface CellProps {
  readonly backgroundColor?: string;
  readonly colspan?: number;
  readonly rowspan?: number;
  readonly colwidth?: readonly (number | null)[] | null;
}

/** The parts of a table block the frame reads. */
interface TableBlockLike {
  readonly children: readonly { readonly children: readonly { readonly props: CellProps }[] }[];
}

/** The `this` a frame is drawn with. */
interface FrameContext {
  readonly renderType: 'nodeView' | 'dom';
}

/**
 * Draws one `<col>` per column of the grid and sizes the table, the way
 * prosemirror-tables' `updateColumnsOnResize` does. Each column takes its width
 * from the first cell that stands in it, so the columns a short first row
 * lacks are drawn too.
 * @param colgroup - The table's `<colgroup>`.
 * @param table - The `<table>`.
 * @param block - The table block.
 */
function drawColumns(colgroup: HTMLElement, table: HTMLElement, block: TableBlockLike): void {
  const widths: (number | null)[] = [];
  // How many more rows a span from above holds each column for.
  let held: number[] = [];
  for (const row of block.children) {
    let column = 0;
    for (const cell of row.children) {
      while ((held[column] ?? 0) > 0) column += 1;
      for (let k = 0; k < (cell.props.colspan ?? 1); k += 1, column += 1) {
        // A stored 0 is no width, as the table plugin reads it.
        if (widths[column] === undefined) widths[column] = cell.props.colwidth?.[k] || null;
        held[column] = cell.props.rowspan ?? 1;
      }
    }
    held = held.map((rows) => rows - 1);
  }
  while (colgroup.childElementCount > widths.length) colgroup.lastElementChild?.remove();
  while (colgroup.childElementCount < widths.length) colgroup.appendChild(document.createElement('col'));
  let total = 0;
  let fixed = true;
  widths.forEach((width, index) => {
    const col = colgroup.children[index] as HTMLElement;
    col.style.width = width === null ? '' : `${width}px`;
    total += width ?? DEFAULT_CELL_WIDTH;
    if (width === null) fixed = false;
  });
  table.style.width = fixed ? `${total}px` : '';
  table.style.minWidth = fixed ? '' : `${total}px`;
  // The width prosemirror-tables' stylesheet gives a column with none stored.
  table.style.setProperty('--default-cell-min-width', `${String(DEFAULT_CELL_WIDTH)}px`);
}

/**
 * Puts the table into the horizontal frame of `DocumentTableScroller`. The
 * table is attached before ProseMirror reads its content DOM. React owns a
 * separate chrome host, and the slot moves that same table into its viewport
 * when the frame commits. A view can be created inside a React effect.
 * @param host - The element the frame is drawn in.
 * @param table - The `<table>`.
 * @returns The React root, to unmount when the view goes.
 */
function mountScroller(host: HTMLElement, table: HTMLElement): Root {
  const chrome = document.createElement('div');
  chrome.className = 'contents';
  host.append(table, chrome);
  const root = createRoot(chrome);
  root.render(
    <DocumentTableScroller>
      <div
        className='tableWrapper'
        ref={(slot) => {
          if (slot !== null && table.parentElement !== slot) slot.appendChild(table);
        }}
      />
    </DocumentTableScroller>,
  );
  return root;
}

/**
 * Writes a cell's spans onto its element, which the browser lays out by, and
 * its stored widths as `colwidth`, which the table rules read to tell a sized
 * column from one the browser sizes.
 * @param element - The `<td>` or `<th>`.
 * @param props - The cell's props.
 */
function applySpans(element: HTMLElement, props: CellProps): void {
  for (const [name, value] of [['colspan', props.colspan], ['rowspan', props.rowspan]] as const) {
    if (value === undefined || value === 1) element.removeAttribute(name);
    else element.setAttribute(name, String(value));
  }
  if (Array.isArray(props.colwidth)) element.setAttribute('colwidth', props.colwidth.join(','));
  else element.removeAttribute('colwidth');
}

/**
 * How far a slice may stay open at one side and still keep its tables
 * closed: the depth of the first table along that side's edge, or the open
 * depth when no table is on it.
 * @param content - The slice's content.
 * @param open - How deep that side is open.
 * @param side - -1 for the start, 1 for the end.
 * @returns The open depth to use.
 */
function openAboveTables(content: Fragment, open: number, side: -1 | 1): number {
  let node = side < 0 ? content.firstChild : content.lastChild;
  for (let depth = 0; node !== null && depth < open; depth += 1) {
    if (node.type.spec['tableRole'] === 'table') return depth;
    node = side < 0 ? node.firstChild : node.lastChild;
  }
  return open;
}

/**
 * A slice with the wrappers it is open through on both sides taken off: one
 * whose only child is open at both ends carries that child's content one
 * level down. A table left inside a wrapper open at both sides is fitted into
 * the line around the caret, its cells' words joining it; a table at the top
 * of a closed slice is placed as a block.
 * @param slice - The slice.
 * @returns The slice without those wrappers.
 */
function unwrapOpenSides(slice: Slice): Slice {
  let { content, openStart, openEnd } = slice;
  while (openStart > 0 && openEnd > 0 && content.childCount === 1) {
    content = content.firstChild!.content;
    openStart -= 1;
    openEnd -= 1;
  }
  return new Slice(content, openStart, openEnd);
}

/**
 * Keeps a pasted table whole. A layout block's node is never isolating
 * (BlockNote `meta.ts`), so a slice opened through a table would join its
 * first or last cell's block with the block around the caret and leave the
 * cell without it. Closing the slice at the table lands the table as a block:
 * in the middle of a line the line splits around it, at its end the table
 * goes under it, and at its start above it, the line kept whole.
 */
const keepPastedTablesWhole = new Plugin({
  key: new PluginKey('doc-table-paste-whole'),
  props: {
    // A cell holds blocks but no table, so a table pasted in a cell is fitted
    // into the cell as before; what a paste into a cell does is inner#1312's.
    transformPasted: (slice, view) => {
      const start = openAboveTables(slice.content, slice.openStart, -1);
      const end = openAboveTables(slice.content, slice.openEnd, 1);
      if (start === slice.openStart && end === slice.openEnd) return slice;
      const closed = new Slice(slice.content, start, end);
      const { selection } = view.state;
      return cellDepthOf(selection.$from) > 0 && heldTables(selection) === null ? closed : unwrapOpenSides(closed);
    },
    // At the start of a line with words, ProseMirror splits the line before
    // the table and leaves its empty first half above it.
    handlePaste: (view, _event, slice) => {
      const { selection } = view.state;
      const { $from } = selection;
      const first = slice.content.firstChild;
      if (!selection.empty || slice.openStart !== 0 || slice.openEnd !== 0 || first?.type.name !== DOC_TABLE) return false;
      if (cellDepthOf($from) > 0) return false;
      if ($from.parentOffset !== 0 || $from.parent.content.size === 0 || $from.node($from.depth - 1).type.name !== 'blockContainer') return false;
      view.dispatch(view.state.tr.insert($from.before($from.depth - 1), slice.content).scrollIntoView());
      return true;
    },
  },
});

/**
 * Replaces tables in a fragment with their cells' blocks in reading order,
 * preserving each block's attributes, marks and nested children.
 * @param content - The fragment to unfold.
 * @returns The fragment with table frames removed.
 */
export function unfoldTables(content: Fragment): Fragment {
  const blocks: PMNode[] = [];
  content.forEach((node) => {
    if (node.type.name === DOC_TABLE) {
      node.forEach((row) => row.forEach((cell) => unfoldTables(cell.content).forEach((block) => blocks.push(block))));
    } else {
      blocks.push(node.isLeaf ? node : node.copy(unfoldTables(node.content)));
    }
  });
  return Fragment.from(blocks);
}

/**
 * A cell excludes tables among its immediate children; a list's block group
 * can still accept one deeper down. Every document-changing entry therefore
 * unfolds such tables, including block API writes and peer updates.
 */
const unfoldCellTables = new Plugin({
  key: new PluginKey('doc-table-unfold-cell-tables'),
  appendTransaction: (transactions, _old, state) => {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const tables: TableAt[] = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name !== DOC_TABLE || cellDepthOf(state.doc.resolve(pos)) < 0) return true;
      tables.push({ pos, node });
      return false;
    });
    if (tables.length === 0) return null;
    const tr = state.tr;
    for (const { pos, node } of tables.reverse()) {
      tr.replaceWith(pos, pos + node.nodeSize, unfoldTables(Fragment.from(node)));
    }
    return tr;
  },
});

/**
 * Whether a step adds content: a cell, for the table plugin's repairs.
 * @param step - The step.
 * @returns True when it does.
 */
function inserts(step: Step): boolean {
  return step instanceof ReplaceStep && step.slice.size > 0;
}

/**
 * The table plugin's repair of one table, in steps against `doc`.
 *
 * `fixTables` scans only the tables that differ from the state it is given,
 * so it is handed the document with this table swapped for a new node with
 * the same content (`Node.copy` would hand back the node itself).
 * @param doc - The document.
 * @param tablePos - The position before the table.
 * @returns The repair, or undefined when the table needs none.
 */
function repairOf(doc: PMNode, tablePos: number): Transaction | undefined {
  const table = doc.nodeAt(tablePos)!;
  const before = doc.replace(tablePos, tablePos + table.nodeSize, new Slice(Fragment.from(table.type.create(table.attrs, table.content, table.marks)), 0, 0));
  return fixTables(EditorState.create({ doc }), EditorState.create({ doc: before }));
}

/**
 * Holds back the table plugin's repairs that add cells, and keeps the rest.
 *
 * `tableEditing` evens every table a transaction touched, a peer's change
 * included. y-prosemirror writes nothing appended to a peer's change back to
 * Yjs, so each client keeps its repair until its next edit writes it, and Yjs
 * keeps every client's added cells: after one person adds a row and another a
 * column, the table gains a column each time both type (prosemirror-tables
 * #249, y-prosemirror CAVEATS "Editor plugins that repair the document").
 * Repairs that set attributes (column widths, spans) or delete converge in
 * Yjs and go through. The plugin writes the repairs of every table it touched
 * in one transaction, which is held back whole when any of them adds a cell;
 * each table's repair writes its attributes first and its added cells last,
 * so here every table left with a problem other than a missing cell gets the
 * steps before its first added cell. A table left short shows
 * placeholders where its cells are missing (`missingCells`), and a command run
 * on it evens it first (`squareTable`).
 */
const holdTableRepairs = new Plugin({
  key: new PluginKey('doc-table-hold-repairs'),
  filterTransaction: (tr) => tr.getMeta(fixTablesKey) === undefined || !tr.steps.some(inserts),
  appendTransaction: (transactions, _old, state) => {
    if (!transactions.some((tr) => tr.docChanged)) return null;
    const tr = state.tr;
    state.doc.descendants((table, tablePos) => {
      if (table.type.name !== DOC_TABLE) return true;
      const problems = TableMap.get(table).problems ?? [];
      if (problems.some((problem) => problem.type !== 'missing')) {
        const repair = repairOf(tr.doc, tr.mapping.map(tablePos));
        const steps = repair?.steps ?? [];
        const first = steps.findIndex(inserts);
        for (const step of first < 0 ? steps : steps.slice(0, first)) tr.step(step);
      }
      return false;
    });
    return tr.docChanged ? tr : null;
  },
});

/**
 * Evens a short table before the table plugin pastes cells into it
 * (`insertCells`, which writes the grid): pasting cells is a command on the
 * table, as merging is.
 */
const squareBeforeCellPaste = new Plugin({
  key: new PluginKey('doc-table-square-before-cell-paste'),
  props: {
    handlePaste: (view, _event, slice) => {
      if (view.state.selection instanceof CellSelection || pastedCells(slice) !== null) squareSelectedTable(view);
      return false;
    },
  },
});

/**
 * The cell a column is read from: the first in it that covers that column
 * alone, else the first in it at all. A short row's missing cell is none.
 * @param map - The table's map.
 * @param table - The table.
 * @param col - The column.
 * @returns The cell's offset in the table.
 */
export function columnCellOf(map: TableMap, table: PMNode, col: number): number {
  let first = 0;
  for (let row = 0; row < map.height; row += 1) {
    const rel = map.map[row * map.width + col]!;
    if (rel === 0) continue;
    if (Number(table.nodeAt(rel)!.attrs['colspan'] ?? 1) === 1) return rel;
    if (first === 0) first = rel;
  }
  return first;
}

/**
 * Draws one placeholder for a cell a short row lacks.
 * @param tag - The tag of the row's cells.
 * @param colwidth - The width of the column it stands in, when set.
 * @returns The widget's element factory.
 */
function missingCell(tag: string, colwidth: number | null): () => HTMLElement {
  return () => {
    const cell = document.createElement(tag);
    cell.contentEditable = 'false';
    cell.dataset['docTableMissing'] = '';
    if (colwidth !== null) cell.setAttribute('colwidth', String(colwidth));
    return cell;
  };
}

/** A cell a short row lacks, in the place it is drawn and evened into. */
interface MissingCell {
  /** Its offset in the table: the end of its row's content. */
  readonly at: number;
  /** Its row. */
  readonly row: number;
  /** Its column. */
  readonly column: number;
  /** Whether it is a header cell, judged as `missingCellsOf` says. */
  readonly header: boolean;
  /** The width of the column it stands in, when one is stored. */
  readonly colwidth: number | null;
}

/**
 * The cells each short row of a table lacks, at the row's end, in order.
 * @param table - The table.
 * @returns The missing cells.
 */
function missingCellsOf(table: PMNode): MissingCell[] {
  const found: MissingCell[] = [];
  const map = TableMap.get(table);
  for (const problem of map.problems ?? []) {
    if (problem.type !== 'missing') continue;
    let rowPos = 0;
    for (let index = 0; index < problem.row; index += 1) rowPos += table.child(index).nodeSize;
    const row = table.child(problem.row);
    // A header row's cells are headers, as the header row switch reads it
    // (`headerOn`); otherwise the row's last cell's kind, unless that cell
    // stands in a header column: the rule `addColumn` follows for a new
    // column's cells.
    const last = row.lastChild;
    const lastAt = rowPos + row.nodeSize - 1 - (last?.nodeSize ?? 0);
    const header =
      (problem.row === 0 && rowIsHeader(map, table, 0)) ||
      (last?.type.name === DOC_TABLE_HEADER &&
        !columnIsHeader(map, table, map.colCount(lastAt) + Number(last.attrs['colspan'] ?? 1) - 1));
    for (let column = 0; column < map.width; column += 1) {
      if (map.map[problem.row * map.width + column] !== 0) continue;
      // The width the column is drawn at; a stored 0 is no width.
      const rel = columnCellOf(map, table, column);
      const stored = table.nodeAt(rel)!.attrs['colwidth'] as (number | null)[] | null;
      const colwidth = stored?.[column - map.colCount(rel)] || null;
      found.push({ at: rowPos + row.nodeSize - 1, row: problem.row, column, header, colwidth });
    }
  }
  return found;
}

/**
 * Evens one table's grid in a transaction: short rows are filled at their end,
 * where their missing cells are drawn (`missingCellsOf`), and the rest of the
 * table plugin's repair (overlapping spans, the new cells' column widths)
 * follows.
 *
 * The user running a command on the table is the one who evens it; the table
 * plugin's own repairs that add cells are held back (`holdTableRepairs`).
 * `fixTables` fills a short first row at its start, so it is handed the table
 * with its rows already filled.
 * @param tr - The transaction to add the repair to.
 * @param tablePos - The position before the table.
 */
export function squareTable(tr: Transaction, tablePos: number): void {
  const table = tr.doc.nodeAt(tablePos);
  if (table === null || TableMap.get(table).problems === null) return;
  const { nodes } = tr.doc.type.schema;
  // The last first, so each insertion leaves the offsets before it standing.
  for (const missing of missingCellsOf(table).reverse()) {
    const type = nodes[missing.header ? DOC_TABLE_HEADER : DOC_TABLE_CELL]!;
    tr.insert(tablePos + 1 + missing.at, type.createAndFill()!);
  }
  repairOf(tr.doc, tablePos)?.steps.forEach((step) => tr.step(step));
}

/**
 * Evens the table the selection is in, in a transaction of its own, before a
 * command of `prosemirror-tables` reads the editor's state.
 * @param view - The editor view.
 * @param view.state - Its state.
 * @param view.dispatch - Where the repair goes.
 */
export function squareSelectedTable(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  const { selection } = view.state;
  const $cell = selection instanceof CellSelection ? selection.$anchorCell : cellAround(selection.$head);
  if ($cell === null) return;
  const tr = view.state.tr;
  squareTable(tr, $cell.before($cell.depth - 1));
  if (tr.docChanged) view.dispatch(tr);
}

/**
 * Placeholders at the end of each row short of cells.
 * @param doc - The document.
 * @returns The decorations.
 */
function missingCellDecorations(doc: PMNode): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((table, tablePos) => {
    if (table.type.name !== DOC_TABLE) return true;
    for (const { at, row, column, header, colwidth } of missingCellsOf(table)) {
      const tag = header ? 'th' : 'td';
      found.push(Decoration.widget(tablePos + 1 + at, missingCell(tag, colwidth), {
        key: `doc-table-missing:${String(row)}:${String(column)}:${tag}:${String(colwidth)}`,
        side: 1,
        ignoreSelection: true,
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, found);
}

/** Placeholders where a short table lacks cells. */
const missingCells: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  key: new PluginKey('doc-table-missing-cells'),
  state: {
    init: (_config, state) => missingCellDecorations(state.doc),
    apply: (tr, set) => (tr.docChanged ? missingCellDecorations(tr.doc) : set),
  },
  props: { decorations: (state) => missingCells.getState(state) },
});

/**
 * The node schema hook that gives the four table nodes their
 * prosemirror-tables role, with the table editing and column resizing
 * plugins. Only these nodes carry a role, so prosemirror-tables acts on this
 * table alone.
 */
const DocTableEditing = Extension.create({
  name: 'docTableEditing',
  addProseMirrorPlugins: () => [
    columnResizing({
      handleWidth: COLUMN_RESIZE_ZONE,
      cellMinWidth: CELL_MIN_WIDTH,
      defaultCellMinWidth: DEFAULT_CELL_WIDTH,
      View: null,
    }),
    unfoldCellTables,
    squareBeforeCellPaste,
    tableEditing(),
    holdTableRepairs,
    missingCells,
    keepPastedTablesWhole,
  ],
  extendNodeSchema: (extension) => {
    const role = TABLE_ROLES[extension.name];
    return role === undefined ? {} : { tableRole: role };
  },
});

/** The cell props both cell kinds carry. */
const CELL_PROP_SCHEMA = {
  backgroundColor: { default: 'default' as const },
  colspan: { default: 1 as const },
  rowspan: { default: 1 as const },
  // Null is what a cell without a stored width holds, the same value the node
  // attribute defaults to, so no `data-colwidth` is written for it.
  colwidth: { default: null as unknown as undefined, type: 'string' as const },
};

/**
 * A cell's column widths read off an element: `data-colwidth` as this editor
 * writes it, `colwidth` as prosemirror-tables and other editors write it.
 * @param element - The `<td>`, `<th>` or the cell's element.
 * @returns One width per column the cell spans, or null when none is given.
 */
function readColwidth(element: HTMLElement): (number | null)[] | null {
  const written = element.getAttribute('data-colwidth') ?? element.getAttribute('colwidth');
  if (written === null || written === '' || written === 'null') return null;
  return written.split(',').map((width) => {
    const value = Number.parseInt(width, 10);
    return Number.isFinite(value) ? value : null;
  });
}

/**
 * The column widths as a node attribute. BlockNote turns a prop into an
 * attribute that parses as a single string or number, and prosemirror-tables
 * reads one width per spanned column, so the attribute reads and writes the
 * list itself.
 */
const COLWIDTH_ATTRIBUTE = {
  default: null,
  keepOnSplit: true,
  parseHTML: readColwidth,
  renderHTML: (attributes: { colwidth?: readonly (number | null)[] | null }): Record<string, string> =>
    Array.isArray(attributes.colwidth) ? { 'data-colwidth': attributes.colwidth.join(',') } : {},
};

/**
 * Reads an integer attribute of at least 1, as a span is written.
 * @param element - The element.
 * @param name - The attribute.
 * @returns The span, 1 when absent or unreadable.
 */
function readSpan(element: HTMLElement, name: string): number {
  const value = Number.parseInt(element.getAttribute(name) ?? '1', 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * One of the two cell kinds.
 * @param type - `docTableCell` or `docTableHeader`.
 * @param tag - The element it draws.
 * @returns Its spec, its node built with {@link COLWIDTH_ATTRIBUTE}.
 */
function cellSpec(type: typeof DOC_TABLE_CELL | typeof DOC_TABLE_HEADER, tag: 'td' | 'th'): unknown {
  const spec = createBlockSpec(
    {
      type,
      propSchema: CELL_PROP_SCHEMA,
      content: 'none',
      layoutOnly: true,
      placeable: 'namedOnly',
      children: { allow: 'blocks', exclude: [DOC_TABLE] },
    },
    {
      experimental_keyboard: { emptyChildEnter: 'stay' },
      // A cell of any `<table>` read in, pasted or written by the Agent; its
      // content parses as blocks.
      parse: (element: HTMLElement) =>
        element.tagName === tag.toUpperCase()
          ? {
            colspan: readSpan(element, 'colspan'),
            rowspan: readSpan(element, 'rowspan'),
            colwidth: readColwidth(element),
          }
          : undefined,
      renderFrame: (block: { props: CellProps }) => {
        const cell = document.createElement(tag);
        applySpans(cell, block.props);
        return {
          dom: cell,
          slot: cell,
          update: (next: { props: CellProps }): boolean => {
            applySpans(cell, next.props);
            return true;
          },
        };
      },
    } as never,
  )();
  const built = addNodeAndExtensionsToSpec(spec.config as never, spec.implementation as never, spec.extensions);
  const node = built.implementation.node.extend({
    addAttributes(this: { parent?: () => Record<string, unknown> }) {
      return { ...(this.parent?.() ?? {}), colwidth: COLWIDTH_ATTRIBUTE };
    },
  });
  return { ...spec, implementation: { ...spec.implementation, node } };
}

/** The four specs, keyed by type. */
export interface DocTableSpecs {
  readonly docTable: unknown;
  readonly docTableRow: unknown;
  readonly docTableCell: unknown;
  readonly docTableHeader: unknown;
}

/**
 * The block specs of the table.
 * @returns The four specs, keyed by type.
 */
export function docTableSpecs(): DocTableSpecs {
  const table = createBlockSpec(
    {
      type: DOC_TABLE,
      propSchema: {
        quoted: { default: false },
        textColor: { default: 'default' as const },
      },
      content: 'none',
      layoutOnly: true,
      children: { allow: [DOC_TABLE_ROW], min: 1, dissolve: false },
    },
    {
      parse: (element: HTMLElement) => (element.tagName === 'TABLE' ? {} : undefined),
      renderFrame(this: FrameContext, block: TableBlockLike) {
        const element = document.createElement('table');
        const colgroup = document.createElement('colgroup');
        const body = document.createElement('tbody');
        element.append(colgroup, body);
        drawColumns(colgroup, element, block);
        if (this.renderType === 'dom') {
          return { dom: element, slot: body };
        }
        const dom = document.createElement('div');
        dom.className = 'doc-table';
        const host = document.createElement('div');
        host.className = 'doc-table-scroller';
        dom.appendChild(host);
        const root = mountScroller(host, element);
        return {
          dom,
          slot: body,
          update: (next: TableBlockLike): boolean => {
            drawColumns(colgroup, element, next);
            return true;
          },
          destroy: (): void => {
            // React refuses a synchronous unmount while it is rendering, and
            // ProseMirror can tear views down from inside a React commit.
            queueMicrotask(() => root.unmount());
          },
        };
      },
    } as never,
    [createExtension({ key: 'doc-table-editing', tiptapExtensions: [DocTableEditing] })],
  );
  const row = createBlockSpec(
    {
      type: DOC_TABLE_ROW,
      propSchema: {},
      content: 'none',
      layoutOnly: true,
      placeable: 'namedOnly',
      children: { allow: [DOC_TABLE_CELL, DOC_TABLE_HEADER], min: 0 },
    },
    {
      parse: (element: HTMLElement) => (element.tagName === 'TR' ? {} : undefined),
      renderFrame: () => {
        const element = document.createElement('tr');
        return { dom: element, slot: element };
      },
    } as never,
  );
  return {
    docTable: table(),
    docTableRow: row(),
    docTableCell: cellSpec(DOC_TABLE_CELL, 'td'),
    docTableHeader: cellSpec(DOC_TABLE_HEADER, 'th'),
  };
}
