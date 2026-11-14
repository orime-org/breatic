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

import { columnsFit, columnWeight } from '@web/spaces/document/document-column-geometry';
import { attachDivider } from '@web/spaces/document/document-column-resize';

/** The column group. */
export const DOC_COLUMN_LIST = 'docColumnList';

/** One column of a group. */
export const DOC_COLUMN = 'docColumn';

/**
 * Marks a group stacked while its container is too narrow for its columns.
 * @param element - The group's element.
 */
function markStacked(element: HTMLElement): void {
  const count = element.querySelectorAll(':scope > .doc-columns-row > .doc-column').length;
  const fits = columnsFit(element.getBoundingClientRect().width, count);
  if (fits) delete element.dataset['stacked'];
  else element.dataset['stacked'] = '';
}

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

/**
 * The bodies a layout block holds, each a run of blocks of its own: a column
 * group's columns, or a table's cells.
 * @param node - The layout block.
 * @returns Its bodies, in reading order.
 */
export function bodiesOf(node: PMNode): PMNode[] {
  const bodies: PMNode[] = [];
  if (node.type.name === DOC_COLUMN_LIST) {
    node.forEach((column) => bodies.push(column));
  } else {
    node.forEach((row) => row.forEach((cell) => bodies.push(cell)));
  }
  return bodies;
}

/**
 * A group's or a column's external HTML: nothing of its own, so its blocks
 * are laid out flat in reading order (BlockNote appends the children of a
 * layout block whose export places them nowhere to the outer fragment,
 * `serializeBlocksExternalHTML.ts`). A reader of the clipboard then finds
 * them at the top level, as Canvas does pictures (`document-media-paste.ts`).
 * @returns An empty fragment.
 */
function flatOutside(): { dom: DocumentFragment } {
  return { dom: document.createDocumentFragment() };
}

/** The part of the editor the divider writes through. */
type DividerEditor = Parameters<typeof attachDivider>[2];

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
  element.style.flexGrow = String(columnWeight(width));
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
      toExternalHTML: flatOutside,
      renderFrame(this: { renderType: 'dom' | 'nodeView' }, _block: unknown, editor: DividerEditor) {
        const element = document.createElement('div');
        element.className = 'doc-columns';
        element.dataset['docColumns'] = '';
        // The columns stand in a row of their own; the divider stands over
        // the group beside it, outside what the editor holds.
        const row = document.createElement('div');
        row.className = 'doc-columns-row';
        element.appendChild(row);
        if (this.renderType === 'dom') return { dom: element, slot: row };
        const detach = attachDivider(element, row, editor);
        // The width the group has decides whether its columns stand side by
        // side; a column added or removed is an update of the group.
        const observer = new ResizeObserver(() => markStacked(element));
        observer.observe(element);
        return {
          dom: element,
          slot: row,
          update: (): boolean => {
            queueMicrotask(() => markStacked(element));
            return true;
          },
          destroy: (): void => {
            observer.disconnect();
            detach();
          },
        };
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
      toExternalHTML: flatOutside,
      parse: (element: HTMLElement) => {
        if (element.dataset['docColumn'] === undefined) return undefined;
        return { width: columnWeight(element.dataset['width']) };
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
