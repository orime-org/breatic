// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a range is taken by in the body it stands in. A body is the page, a
 * table cell or a column (inner#1314); a table and a column group are each one
 * block of the body they stand in. A range whose ends stand in different
 * bodies takes whole the table or group that holds each end right inside the
 * innermost body holding both: a range from a table's cell in a column into
 * the next column takes the group, a range across the columns of a group in
 * one cell takes the group, a range across the cells of a table in one
 * column takes the table.
 */

import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';

import { DOC_COLUMN, DOC_COLUMN_LIST } from '@web/spaces/document/document-column-geometry';
import { DOC_TABLE, isTableCell, type TableAt } from '@web/spaces/document/document-table-nodes';

/**
 * Whether a node is a body of its own.
 * @param node - The node.
 * @param cellsHold - Whether a cell counts as one; a table the editor shows
 * taken whole (`heldTables`) is taken whole even with both ends in a cell.
 * @returns True for a cell (when they count) or a column.
 */
function isBody(node: PMNode, cellsHold: boolean): boolean {
  return node.type.name === DOC_COLUMN || (cellsHold && isTableCell(node));
}

/**
 * The depth of the innermost body holding two positions.
 * @param $a - One position.
 * @param $b - The other.
 * @param cellsHold - Whether a cell counts as a body.
 * @returns The depth, 0 for the page.
 */
export function bodyDepthBetween($a: ResolvedPos, $b: ResolvedPos, cellsHold = true): number {
  let depth = $a.sharedDepth($b.pos);
  while (depth > 0 && !isBody($a.node(depth), cellsHold)) depth -= 1;
  return depth;
}

/**
 * The table or column group holding a position right inside a body.
 * @param $pos - The position.
 * @param bodyDepth - The body's depth, from `bodyDepthBetween`.
 * @returns It, or null when the position stands in that body itself.
 */
export function carrierAt($pos: ResolvedPos, bodyDepth: number): TableAt | null {
  for (let depth = bodyDepth + 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
    if (node.type.name === DOC_TABLE || node.type.name === DOC_COLUMN_LIST) return { pos: $pos.before(depth), node };
  }
  return null;
}
