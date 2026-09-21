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

import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';

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
const FULL_WIDTH = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

/**
 * How tall a node will be once it is on the canvas.
 *
 * An empty node and one waiting for Generate are the standard footprint. A
 * node carrying words is as tall as the words wrap to, between the minimum its
 * body declares and the height at which it starts to clip.
 * @param node - The proposed node.
 * @returns Its height in flow coordinates.
 * @throws {never} Never.
 */
export function estimateHeight(node: ProposalNode): number {
  if (node.role !== 'written') return EMPTY_NODE_SIZE.height;
  const room = EMPTY_NODE_SIZE.width - BODY_PADDING_PX;
  const lines = promptPlainText(node.prompt ?? [])
    .split('\n')
    .reduce((total, line) => {
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
  // The same depths the card's little diagram is drawn from, so what the
  // reader saw before pressing is the arrangement they get.
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
