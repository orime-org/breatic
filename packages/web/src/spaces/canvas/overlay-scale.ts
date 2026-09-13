// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas zoom at and above which screen-anchored overlays keep a constant
 * screen size; below it they stop growing and shrink with the canvas instead.
 * {@link overlayCounterScale} names the four places that read this. Without a floor, the
 * `1 / zoom` counter-scale grows without bound as you zoom out, so a constant-
 * size overlay dwarfs the (now tiny) node. The floor caps that so the overlays
 * follow the canvas once it is small enough. 0.5 = 50% zoom.
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
 * across the threshold.
 *
 * Four places read it: a node's header (`flow-node-types.tsx` hands the same
 * number to the name, the modality icon and the task-counts column), the edge
 * scissors, the remote-cursor layer, and the counts geometry below.
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
 * One cell is a mark inside padding inside a border, and the column is a
 * single file of them, so its width is one cell's. The cell renders those
 * three as Tailwind classes (`size-3`, `p-1.5`, the `outline` variant's
 * border) while this reasons about them as a number; `TaskCountColumn`'s tests
 * measure the rendered cell against this so the two hold the same width.
 */
export const COUNTS_CELL_MARK = 12;
/** Padding the cell holds on each side of its mark, in screen pixels. */
export const COUNTS_CELL_PADDING = 6;
/** The cell's border, in screen pixels — every rule in this product is one. */
export const COUNTS_CELL_BORDER = 1;

const COUNTS_COLUMN_WIDTH =
  COUNTS_CELL_MARK + COUNTS_CELL_PADDING * 2 + COUNTS_CELL_BORDER * 2;

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
 * Smallest a click target may be on screen, in CSS pixels (WCAG 2.2 SC 2.5.8).
 */
const MIN_TARGET_SIZE = 24;

/**
 * The column's screen size at a given zoom.
 * @param zoom - The current canvas zoom.
 * @returns One cell's width in screen pixels.
 */
function countsCellScreenSize(zoom: number): number {
  return COUNTS_COLUMN_WIDTH * overlayCounterScale(zoom) * Math.max(zoom, 0);
}

/**
 * Whether one counts cell still measures the smallest a target may be.
 *
 * The cells stack against each other with a gap that shrinks alongside them.
 * Below the counter-scale floor they follow the canvas down, so past a certain
 * zoom a press lands on whichever of them the cursor happened to be nearest —
 * which is what the target-size minimum exists to prevent.
 * @param zoom - The current canvas zoom (ReactFlow `transform[2]`).
 * @returns True while one cell still measures at least 24 screen pixels.
 */
export function cellMeetsTargetSize(zoom: number): boolean {
  return countsCellScreenSize(zoom) >= MIN_TARGET_SIZE;
}

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
