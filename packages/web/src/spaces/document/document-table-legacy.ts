// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The table documents held before cells could hold blocks (inner#1619), kept
 * so a document that still carries one shows it.
 *
 * collab converts these into `docTable` when it loads a document; a client
 * meets one only when that conversion failed or an outdated tab inserted one
 * mid-session. It is shown and its words can be edited, nothing more:
 *
 * - The node names, attributes and content rules are the ones stored
 *   documents hold (`table > tableRow > tableCell | tableHeader >
 *   tableParagraph`), so Yjs content binds to them unchanged.
 * - No `tableRole`: prosemirror-tables accepts one node type per role, and
 *   the role belongs to `docTable`.
 * - No parse rules: nothing pasted, dropped or written by the Agent becomes
 *   one of these.
 * - None of the library's table extension: its Enter jumps rows in any table
 *   and it registers a second `tableEditing`.
 */

import { createBlockSpecFromTiptapNode } from '@blocknote/core';
import { Node } from '@tiptap/core';

/** The `data-quoted` attribute every block's `quoted` prop renders as. */
const QUOTED_ATTRIBUTE = 'data-quoted';

/**
 * Draws a node as one element holding its content.
 * @param tag - The element's tag.
 * @param attributes - The node's rendered attributes.
 * @returns The element as both dom and content holder.
 */
function holder(tag: string, attributes: Record<string, unknown>): { dom: HTMLElement; contentDOM: HTMLElement } {
  const dom = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) dom.setAttribute(name, String(value));
  }
  return { dom, contentDOM: dom };
}

/** The cell attributes stored documents carry, besides the colour ones the library adds by name. */
const CELL_ATTRIBUTES = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null },
};

const LegacyTableParagraph = Node.create({
  name: 'tableParagraph',
  group: 'tableContent',
  content: 'inline*',
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => holder('p', HTMLAttributes),
});

const LegacyTableHeader = Node.create({
  name: 'tableHeader',
  content: 'tableContent+',
  isolating: true,
  addAttributes: () => CELL_ATTRIBUTES,
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => holder('th', HTMLAttributes),
});

const LegacyTableCell = Node.create({
  name: 'tableCell',
  content: 'tableContent+',
  isolating: true,
  addAttributes: () => CELL_ATTRIBUTES,
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => holder('td', HTMLAttributes),
});

const LegacyTableRow = Node.create({
  name: 'tableRow',
  // A row every cell of which is covered from above has none of its own.
  content: '(tableCell | tableHeader)*',
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => holder('tr', HTMLAttributes),
});

const LegacyTable = Node.create({
  name: 'table',
  group: 'blockContent',
  content: 'tableRow+',
  isolating: true,
  addAttributes: () => ({
    quoted: {
      default: false,
      keepOnSplit: true,
      parseHTML: (element: HTMLElement): boolean => element.getAttribute(QUOTED_ATTRIBUTE) === 'true',
      renderHTML: (attributes: { quoted?: boolean }): Record<string, string> =>
        attributes.quoted === true ? { [QUOTED_ATTRIBUTE]: 'true' } : {},
    },
  }),
  parseHTML: () => [],
  renderHTML({ HTMLAttributes }) {
    const block = holder('div', { ...HTMLAttributes, class: 'bn-block-content', 'data-content-type': 'table' });
    const table = document.createElement('table');
    const body = document.createElement('tbody');
    table.appendChild(body);
    block.dom.appendChild(table);
    return { dom: block.dom, contentDOM: body };
  },
  addExtensions: () => [LegacyTableRow, LegacyTableCell, LegacyTableHeader, LegacyTableParagraph],
});

/**
 * The block spec for a stored legacy table.
 * @returns The spec to put under `table` in the schema.
 */
export function legacyTableSpec(): ReturnType<typeof createBlockSpecFromTiptapNode> {
  return createBlockSpecFromTiptapNode(
    { node: LegacyTable, type: 'table', content: 'table' },
    { textColor: { default: 'default' }, quoted: { default: false } },
  );
}
