// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a column group may go in (inner#1314 design §5.1): right in the body
 * or right in a cell, never in a column at any depth (a table's cell in a
 * column too), never in a nested group under another block. Pasting,
 * dropping and dragging content holding one ask here first.
 */

import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';

import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-nodes';
import { isTableCell } from '@web/spaces/document/document-table-nodes';

/**
 * Whether any of these nodes is a column group or holds one.
 * @param nodes - The nodes.
 * @returns True when one does.
 */
export function holdsColumns(nodes: readonly PMNode[]): boolean {
  let found = false;
  for (const node of nodes) {
    if (node.type.name === DOC_COLUMN_LIST) return true;
    node.descendants((child) => {
      if (child.type.name === DOC_COLUMN_LIST) found = true;
      return !found;
    });
    if (found) return true;
  }
  return false;
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
