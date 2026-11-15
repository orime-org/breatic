// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The canvas geometry of following a member (#920): what part of the canvas a
 * viewport shows, the viewport that shows a leader's part, and whether two
 * rectangles are the same.
 */

import { getViewportForBounds, type Viewport } from '@xyflow/react';

import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from '@web/lib/canvas-zoom';

/** A rectangle in canvas (flow) coordinates. */
export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The size of the canvas pane on screen, in pixels. */
export interface PaneSize {
  width: number;
  height: number;
}

/**
 * The canvas rectangle a viewport shows.
 * @param viewport - The viewport transform.
 * @param pane - The pane's size on screen.
 * @returns The visible rectangle in flow coordinates.
 */
export function visibleRect(viewport: Viewport, pane: PaneSize): FlowRect {
  return {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: pane.width / viewport.zoom,
    height: pane.height / viewport.zoom,
  };
}

/**
 * The viewport that shows the whole of a leader's rectangle, centred, scaled
 * to fit when the panes' aspects differ (as tldraw does), within the canvas
 * zoom range.
 * @param rect - The leader's visible rectangle.
 * @param pane - This client's pane size.
 * @returns The viewport to set.
 */
export function followViewport(rect: FlowRect, pane: PaneSize): Viewport {
  return getViewportForBounds(rect, pane.width, pane.height, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM, 0);
}

/**
 * Whether two rectangles show the same part of the canvas; a missing one
 * (null or undefined) equals only another missing one.
 * @param a - One rectangle.
 * @param b - The other.
 * @returns True when they match.
 */
export function sameRect(a: FlowRect | null | undefined, b: FlowRect | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
