// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** The minimap's default panel size (the library's, we don't override it). */
const MINIMAP_WIDTH = 200;
const MINIMAP_HEIGHT = 150;

/** An axis-aligned rectangle in flow units. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Inputs mirroring the slice of ReactFlow store state the formula needs. */
export interface MinimapViewScaleInputs {
  /** Viewport translation x (store `transform[0]`). */
  tx: number;
  /** Viewport translation y (store `transform[1]`). */
  ty: number;
  /** Viewport zoom (store `transform[2]`). */
  zoom: number;
  /** Rendered flow width in px (store `width`). */
  flowWidth: number;
  /** Rendered flow height in px (store `height`). */
  flowHeight: number;
  /** Bounds of all nodes in flow units, or null when the canvas is empty. */
  nodesBounds: Rect | null;
}

/**
 * Union of two rectangles.
 * @param a - First rectangle.
 * @param b - Second rectangle.
 * @returns The smallest rectangle containing both.
 */
function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Flow-units-per-minimap-pixel, mirroring the library's internal `viewScale`
 * (source-verified v12.10.2: viewport box ∪ nodes bounds, divided by the
 * panel size, max of the two axes). The library uses this factor to convert
 * `maskStrokeWidth` to a screen-constant stroke but does NOT apply it to
 * `nodeBorderRadius` — computing it here lets the minimap pin the node-rect
 * corner radius to constant screen pixels too (user request 2026-07-03: the
 * radius drifted with canvas zoom).
 * @param inputs - The store-state slice (viewport transform, flow size,
 * nodes bounds).
 * @returns The scale factor, falling back to 1 for degenerate inputs
 * (unmeasured flow) so derived values never hit 0/NaN.
 */
export function minimapViewScale(inputs: MinimapViewScaleInputs): number {
  const { tx, ty, zoom, flowWidth, flowHeight, nodesBounds } = inputs;
  const viewBB: Rect = {
    x: -tx / zoom,
    y: -ty / zoom,
    width: flowWidth / zoom,
    height: flowHeight / zoom,
  };
  const rect = nodesBounds ? unionRect(nodesBounds, viewBB) : viewBB;
  const scale = Math.max(
    rect.width / MINIMAP_WIDTH,
    rect.height / MINIMAP_HEIGHT,
  );
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
