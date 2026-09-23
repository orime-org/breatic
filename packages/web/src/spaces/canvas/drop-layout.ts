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
 * Four keeps a batch of the sizes people actually drop to one or two rows on a
 * desktop-width canvas. It is not a promise about fitting: the canvas floors at
 * 420px (`SPACE_MIN_WIDTH`), where a single 288px node already takes most of
 * the width, so at that end the reader pans whatever this says.
 */
const COLUMNS = 4;

/**
 * What a node draws to the right of its own box: the task-count column
 * (`node-task-counts-anchor`, anchored `left-full`), which is what the reader
 * watches while an upload runs. Measured at zoom 1 — `pl-2` (8) plus one cell
 * (`p-1.5` on each side, a `size-3` mark and a 1px border, 26).
 *
 * The column counter-scales with the canvas, so below zoom 1 it covers more
 * canvas than this. That is what zooming out does to every node's column,
 * whether or not the node is in a row.
 */
const COUNTS_PX = 34;

/**
 * The step between neighbours.
 *
 * The width stepped by is the node's box plus the column beside it, so a row
 * leaves each node's counts visible instead of putting the next node on them.
 *
 * The height stepped by is the *empty* node's, not the height the node will
 * end up with: what it grows to depends on the aspect ratio of media that has
 * not finished uploading when the position is fixed, so the finished height is
 * not knowable here. The default footprint is far enough apart to tell the
 * nodes apart, which is all the placement is for (user 2026-09-11).
 */
export const NODE_STEP = {
  x: EMPTY_NODE_SIZE.width + COUNTS_PX + GAP_PX,
  y: EMPTY_NODE_SIZE.height + GAP_PX,
} as const;

/**
 * Where the nodes of one batch go, centred on the point it came in at.
 *
 * One file puts its node's centre on that point, so a batch puts the centre of
 * what the batch adds up to there: the reader points at a place and the thing
 * they handed over appears around it, however many files it was. The whole
 * batch is laid out in one call because the centring needs the count, and a
 * per-index function would let a caller place a batch without it.
 * @param origin - Where the batch came in: the drop point, or the viewport
 * centre when the files arrived by the upload button or a paste.
 * @param count - How many files the batch admitted.
 * @returns One centre per file, in the order the files were handed over.
 */
export function batchCentresAt(
  origin: DropPoint,
  count: number,
): DropPoint[] {
  const columns = Math.min(count, COLUMNS);
  const rows = Math.ceil(count / COLUMNS);
  const left = origin.x - ((columns - 1) * NODE_STEP.x) / 2;
  const top = origin.y - ((rows - 1) * NODE_STEP.y) / 2;
  return Array.from({ length: count }, (_, index) => ({
    x: left + (index % COLUMNS) * NODE_STEP.x,
    y: top + Math.floor(index / COLUMNS) * NODE_STEP.y,
  }));
}
