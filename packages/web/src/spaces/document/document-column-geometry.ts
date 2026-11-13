// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The geometry of a column group (inner#1314 design §5.1), read by the node,
 * the drop, the divider and the side menu alike.
 */

/** The most columns a group holds. */
export const MAX_COLUMNS = 4;

/** The narrowest a column may be made: a new column, a dragged divider. */
export const MIN_COLUMN_WIDTH = 96;

/** The gap between two columns; the divider stands in its middle. */
export const COLUMN_GAP = 72;

/**
 * Whether a container this wide holds this many columns side by side.
 * @param width - The container's width.
 * @param count - How many columns.
 * @returns True when every column gets the minimum.
 */
export function columnsFit(width: number, count: number): boolean {
  return count <= 1 || width >= count * MIN_COLUMN_WIDTH + (count - 1) * COLUMN_GAP;
}
