// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The canvas geometry of following a member (#920): what part of the canvas a
 * viewport shows, the viewport that shows a leader's part, and what a follower
 * publishes while its viewport is being led.
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
 * The rectangle this client publishes as its `camera`: its own while the user
 * drives the viewport, the leader's unchanged while following drives it, so
 * two members following each other settle on one rectangle instead of growing
 * it each round, and a chain of followers passes the leader's on.
 * @param own - The rectangle this client's viewport shows.
 * @param leader - The leader's rectangle while following drives the viewport, else null.
 * @returns The rectangle to publish.
 */
export function publishedCamera(own: FlowRect, leader: FlowRect | null): FlowRect {
  return leader ?? own;
}
