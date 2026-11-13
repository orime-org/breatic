// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The column group layout blocks (inner#1314 design §5.1): a `docColumnList`
 * holds `docColumn`s side by side, and each column holds blocks.
 *
 * - The group holds any number of columns (`docColumn*`), and BlockNote does
 *   not dissolve it (`dissolve: false`): a state two collaborators merge into
 *   can hold one column or none, and a content expression it fails makes
 *   y-prosemirror delete the whole element with the column left in it
 *   (`sync-plugin.js` `createNodeFromYElement`). Our own repair
 *   (`document-column-repair.ts`) dissolves and deletes on local edits.
 * - A column holds at least one block (`allow: 'blocks'` takes no minimum,
 *   `validateChildren.ts:68-71`); an emptied column a merge brings in is
 *   deleted by the binding, and holds nothing.
 * - Enter on an empty last paragraph stays in the column, as in a cell.
 */

import { createBlockSpec } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';

/** The column group. */
export const DOC_COLUMN_LIST = 'docColumnList';

/** One column of a group. */
export const DOC_COLUMN = 'docColumn';

/**
 * Whether a node is a column.
 * @param node - The node.
 * @returns True for a `docColumn`.
 */
export function isColumn(node: PMNode): boolean {
  return node.type.name === DOC_COLUMN;
}

/**
 * Whether a node is a column group.
 * @param node - The node.
 * @returns True for a `docColumnList`.
 */
export function isColumnList(node: PMNode): boolean {
  return node.type.name === DOC_COLUMN_LIST;
}

/** A column's props as the block API carries them. */
interface ColumnProps {
  readonly width: number;
}

/**
 * Writes a column's share of its group's width.
 * @param element - The column's element.
 * @param width - Its weight among its siblings.
 */
function applyWidth(element: HTMLElement, width: number): void {
  const weight = Number.isFinite(width) && width > 0 ? width : 1;
  element.style.flexGrow = String(weight);
}

/** The two specs, keyed by type. */
export interface DocColumnSpecs {
  readonly docColumnList: unknown;
  readonly docColumn: unknown;
}

/**
 * The block specs of a column group.
 * @returns The two specs, keyed by type.
 */
export function docColumnSpecs(): DocColumnSpecs {
  const list = createBlockSpec(
    {
      type: DOC_COLUMN_LIST,
      propSchema: {},
      content: 'none',
      layoutOnly: true,
      children: { allow: [DOC_COLUMN], min: 0, dissolve: false },
    },
    {
      parse: (element: HTMLElement) => (element.dataset['docColumns'] !== undefined ? {} : undefined),
      renderFrame: () => {
        const element = document.createElement('div');
        element.className = 'doc-columns';
        element.dataset['docColumns'] = '';
        return { dom: element, slot: element };
      },
    } as never,
  );
  const column = createBlockSpec(
    {
      type: DOC_COLUMN,
      propSchema: { width: { default: 1 } },
      content: 'none',
      layoutOnly: true,
      placeable: 'namedOnly',
      children: { allow: 'blocks', exclude: [DOC_COLUMN_LIST] },
    },
    {
      experimental_keyboard: { emptyChildEnter: 'stay' },
      parse: (element: HTMLElement) => {
        if (element.dataset['docColumn'] === undefined) return undefined;
        const width = Number(element.dataset['width'] ?? '1');
        return { width: Number.isFinite(width) && width > 0 ? width : 1 };
      },
      renderFrame: (block: { props: ColumnProps }) => {
        const element = document.createElement('div');
        element.className = 'doc-column';
        element.dataset['docColumn'] = '';
        element.dataset['width'] = String(block.props.width);
        applyWidth(element, block.props.width);
        return {
          dom: element,
          slot: element,
          update: (next: { props: ColumnProps }): boolean => {
            element.dataset['width'] = String(next.props.width);
            applyWidth(element, next.props.width);
            return true;
          },
        };
      },
    } as never,
  );
  return { docColumnList: list(), docColumn: column() };
}
