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
import { Slice, type Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { columnResizing, tableEditing } from '@tiptap/pm/tables';
import { flushSync } from 'react-dom';
import { ySyncPluginKey } from 'y-prosemirror';

import { deriveId } from '@breatic/shared';
import { createRoot, type Root } from 'react-dom/client';

import { DocumentTableScroller } from '@web/spaces/document/DocumentTableScroller';

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
 * Draws one `<col>` per column of the first row and sizes the table, the way
 * prosemirror-tables' `updateColumnsOnResize` does.
 * @param colgroup - The table's `<colgroup>`.
 * @param table - The `<table>`.
 * @param block - The table block.
 */
function drawColumns(colgroup: HTMLElement, table: HTMLElement, block: TableBlockLike): void {
  const widths: (number | null)[] = [];
  for (const cell of block.children[0]?.children ?? []) {
    const span = cell.props.colspan ?? 1;
    for (let column = 0; column < span; column++) {
      widths.push(cell.props.colwidth?.[column] ?? null);
    }
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
 * frame is rendered synchronously so the table is in place before
 * ProseMirror first reads the view's DOM.
 * @param host - The element the frame is drawn in.
 * @param table - The `<table>`.
 * @returns The React root, to unmount when the view goes.
 */
function mountScroller(host: HTMLElement, table: HTMLElement): Root {
  const root = createRoot(host);
  flushSync(() => {
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
  });
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
 * Keeps a pasted table whole. A layout block's node is never isolating
 * (BlockNote `meta.ts`), so a slice opened through a table would join its
 * first or last cell's block with the block around the caret and leave the
 * cell without it. Closing the slice at the table lands the table as a block.
 */
const keepPastedTablesWhole = new Plugin({
  key: new PluginKey('doc-table-paste-whole'),
  props: {
    transformPasted: (slice) => {
      const start = openAboveTables(slice.content, slice.openStart, -1);
      const end = openAboveTables(slice.content, slice.openEnd, 1);
      return start === slice.openStart && end === slice.openEnd ? slice : new Slice(slice.content, start, end);
    },
  },
});

/**
 * Whether a transaction was appended to a peer's change.
 * @param tr - The transaction.
 * @returns True when its root is a change y-prosemirror applied from Yjs.
 */
function appendedToPeer(tr: Transaction): boolean {
  const root = tr.getMeta('appendedTransaction') as Transaction | undefined;
  const sync = root?.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return sync?.isChangeOrigin === true;
}

/**
 * Gives the cells the table plugin adds after a peer's change ids every
 * client derives alike.
 *
 * Two people changing one table's shape at once (a row here, a column there)
 * leave it short of cells once the changes meet, and each client's
 * `fixTables` adds the missing ones. y-prosemirror applies a peer's change
 * inside its mutex and does not write what is appended to it back to Yjs
 * (`sync-plugin.js` `_typeChanged`), so each client keeps its own added cells.
 * Ids from the random generator would differ between the two; an id derived
 * from the table, the cell's place and its row's other cells is the same on
 * both. Runs ahead of BlockNote's UniqueID (priority 10000), which would
 * otherwise mint random ones first.
 */
const DocTablePeerFixIds = Extension.create({
  name: 'docTablePeerFixIds',
  priority: 10001,
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey('doc-table-peer-fix-ids'),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((tr) => tr.docChanged && appendedToPeer(tr))) return null;
        const tr = state.tr;
        state.doc.descendants((table, tablePos) => {
          if (table.type.name !== DOC_TABLE) return true;
          table.forEach((row, rowOffset, rowIndex) => {
            const known: string[] = [];
            row.forEach((cell) => known.push(String(cell.attrs['id'])));
            row.forEach((cell, cellOffset, cellIndex) => {
              const cellPos = tablePos + 1 + rowOffset + 1 + cellOffset;
              const cellId =
                (cell.attrs['id'] as string | null) ??
                deriveId(`doc-table-cell:${String(table.attrs['id'])}:${String(rowIndex)}:${String(cellIndex)}:${known.join(',')}`);
              if (cell.attrs['id'] === null) tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, id: cellId });
              cell.descendants((inner, rel) => {
                if (inner.type.isInGroup('bnBlock') && inner.attrs['id'] === null) {
                  tr.setNodeMarkup(cellPos + 1 + rel, undefined, { ...inner.attrs, id: deriveId(`${cellId}:${String(rel)}`) });
                }
                return true;
              });
            });
          });
          return false;
        });
        return tr.docChanged ? tr.setMeta('addToHistory', false) : null;
      },
    }),
  ],
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
    tableEditing(),
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
    [createExtension({ key: 'doc-table-editing', tiptapExtensions: [DocTableEditing, DocTablePeerFixIds] })],
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
