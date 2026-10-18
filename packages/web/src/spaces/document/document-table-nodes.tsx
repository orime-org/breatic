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

import { createBlockSpec, createExtension } from '@blocknote/core';
import { Extension } from '@tiptap/core';
import { columnResizing, tableEditing } from '@tiptap/pm/tables';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { DocumentTableScroller } from '@web/spaces/document/DocumentTableScroller';

/** The narrowest a column can be dragged. */
const CELL_MIN_WIDTH = 35;

/** The width a column without a stored width counts as. */
export const DEFAULT_CELL_WIDTH = 120;

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
 * Writes a cell's spans onto its element, which the browser lays out by.
 * @param element - The `<td>` or `<th>`.
 * @param props - The cell's props.
 */
function applySpans(element: HTMLElement, props: CellProps): void {
  for (const [name, value] of [['colspan', props.colspan], ['rowspan', props.rowspan]] as const) {
    if (value === undefined || value === 1) element.removeAttribute(name);
    else element.setAttribute(name, String(value));
  }
}

/**
 * The node schema hook that gives the four table nodes their
 * prosemirror-tables role, with the table editing and column resizing
 * plugins. Only these nodes carry a role, so prosemirror-tables acts on this
 * table alone.
 */
const DocTableEditing = Extension.create({
  name: 'docTableEditing',
  addProseMirrorPlugins: () => [
    columnResizing({ cellMinWidth: CELL_MIN_WIDTH, defaultCellMinWidth: DEFAULT_CELL_WIDTH, View: null }),
    tableEditing(),
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
  colwidth: { default: undefined, type: 'string' as const },
};

/**
 * One of the two cell kinds.
 * @param type - `docTableCell` or `docTableHeader`.
 * @param tag - The element it draws.
 * @returns Its spec factory.
 */
function cellSpec(type: typeof DOC_TABLE_CELL | typeof DOC_TABLE_HEADER, tag: 'td' | 'th'): () => unknown {
  return createBlockSpec(
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
  );
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
        host.contentEditable = 'false';
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
      renderFrame: () => {
        const element = document.createElement('tr');
        return { dom: element, slot: element };
      },
    } as never,
  );
  return {
    docTable: table(),
    docTableRow: row(),
    docTableCell: cellSpec(DOC_TABLE_CELL, 'td')(),
    docTableHeader: cellSpec(DOC_TABLE_HEADER, 'th')(),
  };
}
