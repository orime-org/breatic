// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tables for tests, in block JSON.
 *
 * Cases describe a table the way the old `tableContent` did (rows of cells,
 * each cell its words), and this writes the layout table cells hold blocks
 * in (inner#1619): every cell a `docTableCell` (or `docTableHeader`) holding
 * one paragraph of those words.
 */

/** A cell as cases write it: its words, its words with cell props, or its blocks. */
export type CellInput =
  | string
  | {
      readonly type?: string;
      readonly content?: string;
      readonly props?: Readonly<Record<string, unknown>>;
      /** The cell's blocks, in place of one paragraph of `content`. */
      readonly blocks?: readonly unknown[];
    };

/** A table as cases write it. */
export interface TableInput {
  readonly rows: readonly { readonly cells: readonly CellInput[] }[];
  /** How many rows from the top are headers. */
  readonly headerRows?: number;
  /** How many columns from the left are headers. */
  readonly headerCols?: number;
  /** A width per column, written onto the first row's cells. */
  readonly columnWidths?: readonly (number | undefined)[];
}

/**
 * One cell's paragraph.
 * @param words - The words, or none for an empty paragraph.
 * @returns The paragraph block.
 */
function paragraph(words: string | undefined): Record<string, unknown> {
  return words === undefined || words === '' ? { type: 'paragraph' } : { type: 'paragraph', content: words };
}

/**
 * A table block from the way cases describe one.
 * @param input - The rows and their cells.
 * @param props - The table's props.
 * @returns The `docTable` block.
 */
export function tableBlock(input: TableInput, props: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'docTable',
    props,
    children: input.rows.map((row, rowIndex) => {
      let column = 0;
      return {
        type: 'docTableRow',
        children: row.cells.map((cell) => {
          const written = typeof cell === 'string' ? { content: cell } : cell;
          const cellProps: Record<string, unknown> = { ...(written.props ?? {}) };
          const span = Number(cellProps['colspan'] ?? 1);
          if (rowIndex === 0 && input.columnWidths !== undefined) {
            const widths = input.columnWidths.slice(column, column + span);
            if (widths.some((width) => width !== undefined)) {
              cellProps['colwidth'] = widths.map((width) => width ?? null);
            }
          }
          const header =
            written.type === 'docTableHeader' ||
            rowIndex < (input.headerRows ?? 0) ||
            column < (input.headerCols ?? 0);
          column += span;
          return {
            type: header ? 'docTableHeader' : 'docTableCell',
            props: cellProps,
            children: 'blocks' in written && written.blocks !== undefined ? written.blocks : [paragraph(written.content)],
          };
        }),
      };
    }),
  };
}
