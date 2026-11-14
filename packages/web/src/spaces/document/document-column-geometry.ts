// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A column group's node names, shape and geometry (inner#1314 design §5.1),
 * read by the nodes, the walkers, the drop, the divider and the side menu
 * alike. It imports nothing of the editor, so any module can read it.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

/** The column group. */
export const DOC_COLUMN_LIST = 'docColumnList';

/** One column of a group. */
export const DOC_COLUMN = 'docColumn';

/** The most columns a group holds. */
export const MAX_COLUMNS = 4;

/** The narrowest a column may be made: a new column, a dragged divider. */
export const MIN_COLUMN_WIDTH = 96;

/** The gap between two columns; the divider stands in its middle. */
export const COLUMN_GAP = 72;

/**
 * A column's stored width read as its weight: any value that is not a
 * positive number counts as 1.
 * @param value - The stored width.
 * @returns The weight.
 */
export function columnWeight(value: unknown): number {
  const weight = Number(value);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/**
 * The narrowest container that holds this many columns side by side.
 * @param count - How many columns.
 * @returns Its width.
 */
export function columnsWidth(count: number): number {
  return count * MIN_COLUMN_WIDTH + (count - 1) * COLUMN_GAP;
}

/**
 * Whether a container this wide holds this many columns side by side.
 * @param width - The container's width.
 * @param count - How many columns.
 * @returns True when every column gets the minimum.
 */
export function columnsFit(width: number, count: number): boolean {
  return count <= 1 || width >= columnsWidth(count);
}

/**
 * Whether columns of these weights, side by side in a container this wide,
 * are each given the minimum width.
 * @param width - The container's width.
 * @param weights - The columns' weights.
 * @returns True when every column gets the minimum.
 */
export function weightsFit(width: number, weights: readonly number[]): boolean {
  const room = width - (weights.length - 1) * COLUMN_GAP;
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return weights.every((weight) => (weight / sum) * room >= MIN_COLUMN_WIDTH);
}

/**
 * The weight a new column takes: the mean of its group's weights.
 * @param weights - The group's weights.
 * @returns The mean, or 1 for no columns.
 */
export function meanWeight(weights: readonly number[]): number {
  return weights.length === 0 ? 1 : weights.reduce((total, weight) => total + weight, 0) / weights.length;
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
 * Whether a column holds only one empty paragraph.
 * @param column - The column.
 * @returns True when it does.
 */
export function holdsOneEmptyParagraph(column: PMNode): boolean {
  if (column.childCount !== 1) return false;
  const row = column.firstChild!;
  return row.type.name === 'blockContainer' && row.childCount === 1 && row.firstChild!.type.name === 'paragraph' && row.firstChild!.content.size === 0;
}
