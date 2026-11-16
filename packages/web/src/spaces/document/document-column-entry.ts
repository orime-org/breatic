// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a column group may go in (inner#1314 design §5.1): right in the body
 * or right in a cell, never in a column at any depth (a table's cell in a
 * column too), never in a nested group under another block. Pasting,
 * dropping and dragging content holding one ask here first.
 */

import { Node as PMNode, type Fragment, type ResolvedPos } from '@tiptap/pm/model';

import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-geometry';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { isTableCell } from '@breatic/shared/document-model';

/** The column group's type, as a set to search for. */
export const LISTS: ReadonlySet<string> = new Set([DOC_COLUMN_LIST]);

/**
 * Whether a node, or any node inside it or inside content, is of one of these
 * types.
 * @param content - The node or the content.
 * @param types - The type names.
 * @returns True when one is found.
 */
export function holds(content: PMNode | Fragment, types: ReadonlySet<string>): boolean {
  if (content instanceof PMNode && types.has(content.type.name)) return true;
  let found = false;
  content.descendants((child) => {
    if (types.has(child.type.name)) found = true;
    return !found;
  });
  return found;
}

/**
 * Whether any of these nodes is a column group or holds one.
 * @param nodes - The nodes.
 * @returns True when one does.
 */
export function holdsColumns(nodes: readonly PMNode[]): boolean {
  return nodes.some((node) => holds(node, LISTS));
}

/**
 * Whether a column group may not go in at a position.
 * @param $pos - Where it would go.
 * @returns True in a column, or in a nested group with no cell between.
 */
export function columnsBarredAt($pos: ResolvedPos): boolean {
  let inCell = false;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === DOC_COLUMN) return true;
    if (isTableCell(node)) inCell = true;
    if (!inCell && node.type.name === 'blockGroup' && $pos.node(depth - 1).type.name === 'blockContainer') return true;
  }
  return false;
}

/**
 * Whether "Columns" in the insert menu is out of reach on a row: where a
 * group may not go, or on a row with children (design §5.3).
 * @param doc - The document.
 * @param blockId - The pressed row's id.
 * @returns True when the entry is greyed.
 */
export function columnsOutOfReach(doc: PMNode, blockId: string): boolean {
  const row = rowById(doc, blockId);
  if (row === undefined) return true;
  if (row.node.type.name === 'blockContainer' && row.node.childCount > 1) return true;
  return columnsBarredAt(doc.resolve(row.from));
}
