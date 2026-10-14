// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the nodes of a proposed flow land on the canvas (#263).
 *
 * A proposal used to build one thing, so one row read it correctly. A flow
 * forks -- one photo feeding three angles, a written note beside an empty node
 * -- and a row puts a node's feeders beside it instead of before it, which is
 * the one thing the arrangement has to say.
 *
 * Kept apart from the placing itself, and free of anything the canvas holds,
 * so the arrangement can be read by a test with no canvas around it.
 */

import { layersOf, promptPlainText, type CanvasProposal, type ProposalNode } from '@breatic/shared';

import { getViewportForBounds, type Viewport } from '@xyflow/react';

import type { NodePlacement } from '@web/data/yjs/canvas-space';
import { CANVAS_MIN_ZOOM } from '@web/lib/canvas-zoom';
import { EMPTY_NODE_SIZE, mediaNodeHeight, type Rect } from '@web/spaces/canvas/group-geometry';
import { COUNTS_COLUMN_FLOW_DEPTH, COUNTS_COLUMN_FLOW_REACH } from '@web/spaces/canvas/overlay-scale';

/** A point in flow coordinates. */
export interface Spot {
  x: number;
  y: number;
}

/** A node's footprint in flow coordinates. */
export interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far apart two layers of the flow sit, left to right. */
export const LAYER_STEP_PX = 360;

/** How far apart two nodes of one layer sit, top to bottom. */
export const ROW_GAP_PX = 48;

// What a text node's body measures, read off the classes it is drawn with
// (`TextNodeEditor`): `min-h-48` is 192, `max-h-144` is 576, `p-3` is 12 on
// each side, and `text-sm` is 14px type on a 20px line. One estimate here
// rather than a constant step, because a written node is as tall as its words
// and a constant step lets an eleven-line one sit on top of its neighbour.
const BODY_LINE_PX = 20;
const BODY_PADDING_PX = 24;
const BODY_MIN_PX = 192;
const BODY_MAX_PX = 576;

// How wide one character is on that line. A full-width character is the type
// size; everything else is taken as half of it, which is the usual reading of
// East Asian width and close enough for deciding where a node's neighbour
// starts. Measured against a real node in the smoke pass, not here.
const FULL_WIDTH_PX = 14;
const HALF_WIDTH_PX = 7;

/** Codepoint ranges drawn at full width: CJK, kana, hangul and their marks. */
const FULL_WIDTH = /[\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}]/u;


/**
 * How tall a node carrying these words draws: as tall as they wrap to, between
 * the minimum its body declares and the height at which it starts to clip.
 * @param text - The words, one line per paragraph.
 * @returns The node's height in flow coordinates.
 * @throws {never} Never.
 */
export function textFootprintHeight(text: string): number {
  const room = EMPTY_NODE_SIZE.width - BODY_PADDING_PX;
  const lines = text.split('\n').reduce((total, line) => {
    const width = [...line].reduce(
      (sum, ch) => sum + (FULL_WIDTH.test(ch) ? FULL_WIDTH_PX : HALF_WIDTH_PX),
      0,
    );
    return total + Math.max(1, Math.ceil(width / room));
  }, 0);
  const wanted = lines * BODY_LINE_PX + BODY_PADDING_PX;
  return Math.min(BODY_MAX_PX, Math.max(BODY_MIN_PX, wanted));
}

/**
 * How tall a node will be once it is on the canvas.
 *
 * An empty node and one waiting for Generate are the standard footprint. A
 * node holding the reader's picture or video is as tall as it draws at the
 * node's width (inner#1315). A node carrying words is as tall as the words wrap to.
 * @param node - The proposed node.
 * @returns Its height in flow coordinates.
 * @throws {never} Never.
 */
export function estimateHeight(node: ProposalNode): number {
  const media = node.materialMedia;
  if (media?.width && media.height && (node.type === 'image' || node.type === 'video')) {
    return mediaNodeHeight(media.width, media.height);
  }
  if (node.role !== 'written') return EMPTY_NODE_SIZE.height;
  return textFootprintHeight(promptPlainText(node.prompt ?? []));
}

/**
 * Where each node of a proposal goes, in the order the proposal lists them.
 *
 * Nodes with nothing feeding them start the flow; every other node sits one
 * layer to the right of the last thing that feeds it. Layers read left to
 * right, the nodes of one layer stack downwards, and the whole arrangement is
 * centred on the point the reader was looking at.
 * @param proposal - What is being placed.
 * @param centre - The viewport centre, in flow coordinates.
 * @returns One footprint per node, in the same order.
 * @throws {never} Never.
 */
export function planFlowLayout(proposal: CanvasProposal, centre: Spot): Placed[] {
  // The same depths the card's little diagram is drawn from. The card splits
  // its chips into runs on top of this, so a node wired to nothing gets a row
  // of its own there; here it stands in the first column beside whatever else
  // starts the flow, which is what the design asks for (§6.2).
  const layer = layersOf(proposal);

  const height = proposal.nodes.map((node) => estimateHeight(node));
  const columns = new Map<number, number[]>();
  layer.forEach((at, index) => {
    columns.set(at, [...(columns.get(at) ?? []), index]);
  });

  // Each column is stacked downwards and then centred on the point, so a
  // column of one sits level with the middle of a column of three.
  const placed: Placed[] = proposal.nodes.map(() => ({
    x: 0,
    y: 0,
    width: EMPTY_NODE_SIZE.width,
    height: 0,
  }));
  for (const [at, members] of columns) {
    const tall =
      members.reduce((sum, index) => sum + (height[index] ?? 0), 0) +
      ROW_GAP_PX * (members.length - 1);
    let y = centre.y - tall / 2;
    for (const index of members) {
      const own = height[index] ?? 0;
      placed[index] = {
        x: at * LAYER_STEP_PX,
        y,
        width: EMPTY_NODE_SIZE.width,
        height: own,
      };
      y += own + ROW_GAP_PX;
    }
  }

  // Columns were laid out from zero, so the whole arrangement slides sideways
  // onto the point at the end -- there is nothing to centre until the last
  // layer is known.
  const widest = Math.max(...placed.map((p) => p.x + p.width));
  const leftmost = Math.min(...placed.map((p) => p.x));
  const shift = centre.x - (leftmost + widest) / 2;
  return placed.map((p) => ({ ...p, x: p.x + shift }));
}

/**
 * How far right a batch moves so it covers nothing already on the canvas.
 *
 * Only rightwards, and only as far as the first clear spot: a candidate that
 * comes within `gap` of a rect on any side is taken, and the batch jumps past
 * the right edge of whatever took it. Every jump moves strictly right past a
 * finite set of rects, so the walk ends.
 * @param batch - The rect the batch would take where it was aimed.
 * @param occupied - Rects already on the canvas.
 * @param gap - Clear space kept on every side.
 * @returns The distance to move right, zero when the spot is clear.
 * @throws {never} Never.
 */
export function shiftRightPastOccupied(batch: Rect, occupied: readonly Rect[], gap: number): number {
  // Walk the gap-padded left edge itself, set to a hit's right edge as is: the
  // next test then compares that edge with itself and lets it go. Walking the
  // batch's x instead takes the gap back off each time, and (edge + gap) - gap
  // can land a hair short of the edge, which then hits again forever.
  const start = batch.x - gap;
  const top = batch.y - gap;
  const bottom = batch.y + batch.height + gap;
  let left = start;
  for (;;) {
    const right = left + batch.width + gap * 2;
    const hits = occupied.filter(
      (r) => r.x < right && r.x + r.width > left && r.y < bottom && r.y + r.height > top,
    );
    if (hits.length === 0) return left === start ? 0 : left + gap - batch.x;
    left = Math.max(...hits.map((r) => r.x + r.width));
  }
}

/**
 * The rect each node already on the canvas takes, for a batch looking for a
 * clear spot.
 *
 * The canvas mounts only the nodes in view, so one off screen may never have
 * been measured, or kept the size it had before its content changed. Where
 * the document decides the size it is used: a group's own rect, and a picture
 * or video drawn at the node's width. Text takes the taller of what was
 * measured and what its words come to. Every node but a group also has its
 * task counts hung off its top right corner, so it takes the room
 * {@link withTaskCounts} gives it.
 * Notes are left out: a pin draws above every node, so nothing placed over it
 * hides it.
 * @param placements - Every node, as the document places it.
 * @param measuredOf - The size the canvas measured for a node, if it has one.
 * @returns One rect per node that takes room.
 * @throws {never} Never.
 */
export function occupiedRects(
  placements: readonly NodePlacement[],
  measuredOf: (id: string) => { width: number; height: number } | undefined,
): Rect[] {
  const rects: Rect[] = [];
  for (const p of placements) {
    if (p.type === 'annotation') continue;
    const rect = { x: p.x, y: p.y, ...footprintOf(p, measuredOf) };
    rects.push(p.type === 'group' ? rect : withTaskCounts(rect));
  }
  return rects;
}

/**
 * The room a node takes once the task counts it can carry are counted: they
 * hang off its top right corner, past its right edge and, below a short node,
 * past its bottom, as far as they reach at any zoom.
 * @param rect - The node's own rect.
 * @returns The rect with its counts.
 * @throws {never} Never.
 */
export function withTaskCounts(rect: Rect): Rect {
  return {
    ...rect,
    width: rect.width + COUNTS_COLUMN_FLOW_REACH,
    height: Math.max(rect.height, COUNTS_COLUMN_FLOW_DEPTH),
  };
}

/**
 * The size one node takes, by the rule {@link occupiedRects} describes.
 * @param p - The node, as the document places it.
 * @param measuredOf - The size the canvas measured for a node, if it has one.
 * @returns Its width and height in flow coordinates.
 * @throws {never} Never.
 */
function footprintOf(
  p: NodePlacement,
  measuredOf: (id: string) => { width: number; height: number } | undefined,
): { width: number; height: number } {
  if (p.type === 'group') {
    return { width: p.width ?? 0, height: p.height ?? 0 };
  }
  if ((p.type === 'image' || p.type === 'video') && p.mediaWidth && p.mediaHeight) {
    return { width: EMPTY_NODE_SIZE.width, height: mediaNodeHeight(p.mediaWidth, p.mediaHeight) };
  }
  const measured = measuredOf(p.id);
  if (p.type === 'text') {
    // An unmounted node keeps the size it was last measured at, so words
    // written into it off screen are counted by the estimate.
    return {
      width: measured?.width ?? EMPTY_NODE_SIZE.width,
      height: Math.max(measured?.height ?? 0, textFootprintHeight(p.bodyText ?? '')),
    };
  }
  if (measured) return measured;
  return { width: EMPTY_NODE_SIZE.width, height: EMPTY_NODE_SIZE.height };
}

/** Room left around a framed proposal, as `fitView` leaves around the canvas. */
const FRAME_PADDING = 0.1;

/**
 * Where to put the camera once a proposal has landed: centred on what was
 * placed, at the reader's zoom while it fits, zoomed out just enough to show
 * all of it when it does not, never past the canvas floor.
 * @param bounds - The rect of what landed, in flow coordinates.
 * @param pane - The canvas pane's size in screen pixels.
 * @param pane.width - Its width.
 * @param pane.height - Its height.
 * @param zoom - The reader's zoom now.
 * @returns The viewport to move to.
 * @throws {never} Never.
 */
export function frameProposal(bounds: Rect, pane: { width: number; height: number }, zoom: number): Viewport {
  return getViewportForBounds(bounds, pane.width, pane.height, CANVAS_MIN_ZOOM, zoom, FRAME_PADDING);
}
