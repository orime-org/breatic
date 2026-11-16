// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the camera goes once a proposed flow has landed (#263). Where the
 * nodes themselves go is `planFlowLayout` in `@breatic/shared/canvas-model`.
 */

import type { Rect } from '@breatic/shared/canvas-model';
import { getViewportForBounds, type Viewport } from '@xyflow/react';

import { CANVAS_MIN_ZOOM } from '@web/lib/canvas-zoom';

/** Room left around a framed proposal, as `fitView` leaves around the canvas. */
const FRAME_PADDING = 0.1;

/**
 * Where to put the camera once a proposal has landed: centred on what was
 * placed, at the user's zoom while it fits, zoomed out just enough to show
 * all of it when it does not, never past the canvas floor.
 * @param bounds - The rect of what landed, in flow coordinates.
 * @param pane - The canvas pane's size in screen pixels.
 * @param pane.width - Its width.
 * @param pane.height - Its height.
 * @param zoom - The user's zoom now.
 * @returns The viewport to move to.
 * @throws {never} Never.
 */
export function frameProposal(bounds: Rect, pane: { width: number; height: number }, zoom: number): Viewport {
  return getViewportForBounds(bounds, pane.width, pane.height, CANVAS_MIN_ZOOM, zoom, FRAME_PADDING);
}
