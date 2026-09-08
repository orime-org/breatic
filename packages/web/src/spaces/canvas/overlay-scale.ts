// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas zoom at and above which screen-anchored overlays (a node's name
 * header, an edge's scissors button) keep a constant screen size; below it
 * they stop growing and shrink with the canvas instead. Without a floor, the
 * `1 / zoom` counter-scale grows without bound as you zoom out, so a constant-
 * size header / scissors dwarfs the (now tiny) node. The floor caps that so the
 * overlays follow the canvas once it is small enough. 0.5 = 50% zoom.
 */
export const OVERLAY_SCALE_FLOOR_ZOOM = 0.5;

/**
 * Counter-scale factor for a screen-anchored canvas overlay. ReactFlow scales a
 * whole node / edge layer by the canvas `zoom`; an overlay scales by the
 * reciprocal against that so it keeps a constant screen size — but only down to
 * `floorZoom`. At/above the floor the factor is `1 / zoom` (constant screen
 * size); below it the factor is clamped to `1 / floorZoom`, so the overlay's
 * effective screen size (`base * factor * zoom`) shrinks with the canvas. The
 * two branches meet exactly at `zoom === floorZoom`, so the size is continuous
 * across the threshold. Shared by the node name header and the edge scissors.
 * @param zoom - The current canvas zoom (ReactFlow `transform[2]`).
 * @param floorZoom - Zoom below which the overlay follows the canvas; defaults to {@link OVERLAY_SCALE_FLOOR_ZOOM}.
 * @returns The counter-scale factor, or `1` when `zoom <= 0` (defensive — never divides by zero).
 */
export function overlayCounterScale(
  zoom: number,
  floorZoom: number = OVERLAY_SCALE_FLOOR_ZOOM,
): number {
  if (zoom <= 0) return 1;
  return 1 / Math.max(zoom, floorZoom);
}

/**
 * Screen width the counts column holds at or above the counter-scale floor.
 *
 * One cell: a 12px mark inside `p-1.5` with a 1px border on each side. The
 * column is a single file of these, so its width is one cell's.
 */
const COUNTS_COLUMN_WIDTH = 26;

/**
 * Screen gap between the node's edge and the column. It counter-scales with
 * the column so the two read as one piece: measured in flow units it grew
 * with the canvas and pulled the column away from the node it belongs to
 * (user 2026-09-06).
 */
const COUNTS_COLUMN_GAP = 8;

/** Gap the reader sees between the column and whatever is anchored past it. */
const CLEARANCE = 8;

/**
 * How far past a node's right edge something has to sit to clear its task
 * counts column, in screen pixels.
 *
 * The gap and the box both sit inside the counter-scaled wrapper, so each is a
 * constant screen distance (down to the scale floor) and this returns them at
 * the zoom asked for.
 * Anything positioned in screen pixels — an xyflow `NodeToolbar` offset, which
 * is added after the zoom multiply — has to add them up at the current zoom or
 * it only clears the column at the one zoom it was measured at.
 * @param zoom - The current canvas zoom (ReactFlow `transform[2]`).
 * @returns The offset in screen pixels.
 */
export function countsColumnOffset(zoom: number): number {
  const gap =
    COUNTS_COLUMN_GAP * overlayCounterScale(zoom) * Math.max(zoom, 0);
  const box = COUNTS_COLUMN_WIDTH * overlayCounterScale(zoom) * Math.max(zoom, 0);
  return gap + box + CLEARANCE;
}
