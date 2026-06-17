// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
