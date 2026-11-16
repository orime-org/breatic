// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The column group layout blocks (inner#1314 design §5.1): a `docColumnList`
 * holds `docColumn`s side by side, and each column holds blocks.
 *
 * - The group holds any number of columns (`docColumn*`), and BlockNote does
 *   not dissolve it (`dissolve: false`): a state two collaborators merge into
 *   can hold one column or none, and a content expression it fails makes
 *   y-prosemirror delete the whole element with the column left in it
 *   (`sync-plugin.js` `createNodeFromYElement`). Web's own repair
 *   (`document-column-repair.ts`) dissolves and deletes on local edits.
 * - A column holds at least one block (`allow: 'blocks'` takes no minimum,
 *   `validateChildren.ts:68-71`); an emptied column a merge brings in is
 *   deleted by the binding, and holds nothing.
 * - Enter on an empty last paragraph stays in the column, as in a cell.
 *
 * The browser's editor adds the divider and the stacking on narrow widths
 * ({@link DocColumnView}); collab builds these specs with no view at all
 * (breatic#1488 §11.1), and the schema is the same either way.
 */

import { createBlockSpec } from '@blocknote/core';

import { columnWeight, DOC_COLUMN, DOC_COLUMN_LIST } from '@shared/document/model/document-column-geometry.js';

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

/** What the browser mounts on a group's node view, to update and take down with it. */
export interface DocColumnGroupFrame {
  /** Runs after the group changed (a column added, removed or resized). */
  update(): void;
  /** Takes it down. */
  destroy(): void;
}

/**
 * What the browser's editor adds to a column group, none of which changes the
 * schema.
 */
export interface DocColumnView {
  /**
   * Mounts the browser's parts of a group's node view on its element and its
   * row of columns. Without it the node view is the bare group, as the static
   * render is.
   */
  readonly attachGroup?: (element: HTMLElement, row: HTMLElement, editor: unknown) => DocColumnGroupFrame;
}

/** The two specs, keyed by type. */
export interface DocColumnSpecs {
  readonly docColumnList: unknown;
  readonly docColumn: unknown;
}

/**
 * The block specs of a column group.
 * @param view - What the browser's editor adds; nothing by default.
 * @returns The two specs, keyed by type.
 */
export function docColumnSpecs(view: DocColumnView = {}): DocColumnSpecs {
  const { attachGroup } = view;
  const list = createBlockSpec(
    {
      type: DOC_COLUMN_LIST,
      propSchema: {},
      content: 'none',
      layoutOnly: true,
      children: { allow: [DOC_COLUMN], min: 0, dissolve: false },
    },
    {
      // Read as attributes: the parser meets every pasted element, and one
      // outside HTML (MathML's `<math>`) need not carry `dataset`.
      parse: (element: HTMLElement) => (element.hasAttribute('data-doc-columns') ? {} : undefined),
      toExternalHTML: flatOutside,
      renderFrame(this: { renderType: 'dom' | 'nodeView' }, _block: unknown, editor: unknown) {
        const element = document.createElement('div');
        element.className = 'doc-columns';
        element.dataset['docColumns'] = '';
        // The columns stand in a row of their own; the divider stands over
        // the group beside it, outside what the editor holds.
        const row = document.createElement('div');
        row.className = 'doc-columns-row';
        element.appendChild(row);
        if (this.renderType === 'dom' || attachGroup === undefined) return { dom: element, slot: row };
        const frame = attachGroup(element, row, editor);
        return {
          dom: element,
          slot: row,
          update: (): boolean => {
            frame.update();
            return true;
          },
          destroy: (): void => frame.destroy(),
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
        if (!element.hasAttribute('data-doc-column')) return undefined;
        return { width: columnWeight(element.getAttribute('data-width')) };
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
