// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the nodes of one multi-file drop are put.
 *
 * A drop names one point and hands over several files, so the positions have
 * to be derived. They are derived here rather than at the drop so the one
 * thing that decides whether the reader can see what they just dropped is a
 * function a test can walk.
 */

import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';

/** A point on the canvas. */
export interface DropPoint {
  x: number;
  y: number;
}

/**
 * Space between neighbours, so the grid reads as separate nodes rather than a
 * wall. The canvas dot grid is 24px, so a gap of one dot keeps the seam on the
 * background the reader already sees.
 */
const GAP_PX = 24;

/**
 * Nodes across before the next row starts.
 *
 * Four 288px nodes plus their gaps span 1224px, which fits the width a canvas
 * is given at the narrowest desktop the product supports. Past that the drop
 * would lay a row wider than the viewport and the reader would have to pan to
 * find what they dropped.
 */
const COLUMNS = 4;

/**
 * The step between neighbours.
 *
 * The height stepped by is the *empty* node's, not the height the node will
 * end up with: what it grows to depends on the aspect ratio of media that has
 * not finished uploading when the position is fixed, so the finished height is
 * not knowable here. The default footprint is far enough apart to tell the
 * nodes apart, which is all the placement is for (user 2026-09-11).
 */
const STEP = {
  x: EMPTY_NODE_SIZE.width + GAP_PX,
  y: EMPTY_NODE_SIZE.height + GAP_PX,
} as const;

/**
 * Where the nth file of a drop goes.
 * @param origin - Where the drop landed, which is where the first node goes.
 * @param index - The file's place in the batch, from zero.
 * @returns The position for that file's node.
 */
export function dropPositionAt(origin: DropPoint, index: number): DropPoint {
  return {
    x: origin.x + (index % COLUMNS) * STEP.x,
    y: origin.y + Math.floor(index / COLUMNS) * STEP.y,
  };
}
