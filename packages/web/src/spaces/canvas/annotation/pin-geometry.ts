// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How big a collapsed annotation is, and where its coordinate sits.
 *
 * A pin holds the same size on screen at every zoom, because a reader zooms
 * out to see which notes on the whole board still need answering (user
 * 2026-09-15) — a pin too small to hit makes that move pointless.
 *
 * It is delivered by the pin's LAYOUT BOX rather than by a transform: xyflow
 * measures a node with `offsetWidth` (`@xyflow/system@0.0.79 dist/esm/index.js:854`,
 * assigned to `measured` at `:1858`), which a CSS transform is invisible to.
 * A transformed pin and the rect xyflow remembers would be two rects that do
 * not overlap, and marquee selection (`getNodesInside`), group geometry
 * (`group-creation.ts`), the minimap and the sticky's own anchor
 * (`getNodeToolbarTransform`) all read the one nobody can see.
 */

/** The pin's size on screen, in CSS pixels, at any zoom. */
export const PIN_SCREEN_SIZE = 28;

/**
 * Where the node's coordinate sits inside the pin: the tail tip, bottom left.
 *
 * xyflow's own per-node origin (`@xyflow/system:274` and `:463` both read
 * `node.origin ?? nodeOrigin`), so `getNodePositionWithOrigin` folds it into
 * `positionAbsolute` — it is part of the coordinate maths rather than a way of
 * drawing, which is why every consumer of the rect agrees with the eye.
 */
export const PIN_ORIGIN: [number, number] = [0, 1];

/**
 * The pin's size in flow pixels at a given zoom.
 *
 * The canvas scales the node layer by `zoom`, so a box of `28 / zoom` flow
 * pixels lands on screen as 28.
 * @param zoom - The current canvas zoom (ReactFlow `transform[2]`).
 * @returns The width and height to write on the pin element, in flow pixels;
 *   the unscaled size when `zoom` is zero or less (defensive — never divides
 *   by zero).
 */
export function pinFlowSize(zoom: number): number {
  if (zoom <= 0) return PIN_SCREEN_SIZE;
  return PIN_SCREEN_SIZE / zoom;
}
