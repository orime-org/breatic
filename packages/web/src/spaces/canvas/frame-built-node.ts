// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where to move the canvas after an action makes something: a press that
 * writes a node beside another one, or a paste or duplicate that makes copies.
 *
 * A node written one step to the right of the one being read is off-screen on
 * a canvas scrolled near its right edge, and a press whose only effect is
 * off-screen looks like a press that did nothing. Moving every time is the
 * other half of that: a reader who can already see both nodes has the canvas
 * slide under them for no reason they can name.
 */

import type { Viewport } from '@xyflow/react';

import { frameProposal } from '@web/spaces/canvas/lib/place-flow';
import {
  centerOf,
  groupRectForMembers,
  type Point,
  type Rect,
} from '@web/spaces/canvas/group-geometry';

/** Room left around a node framed for a close look, as a fit leaves around the canvas. */
const INSPECT_PADDING = 0.1;

/** How long the canvas takes to slide what an action just made into view. */
export const FRAME_PAN_MS = 300;

/**
 * How long the camera takes to follow a proposal onto the canvas. Longer than
 * a slide, because it often travels further and zooms out on the way, and at
 * the slide's pace the reader loses where it went (user 2026-10-13).
 */
export const PROPOSAL_FRAME_MS = 800;

/**
 * Whether one rect lies entirely within another.
 * @param inner - The rect being looked for.
 * @param outer - The rect being looked in.
 * @returns True when every edge of `inner` is inside `outer`.
 */
function contains(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Where to centre the canvas so the node just built is in front of the reader.
 *
 * Nothing moves while that node is already fully in view. When it is not, the
 * canvas frames it together with the node it was read from — the two belong to
 * one act, and showing one without the other says half of what happened. The
 * zoom is the reader's and stays that way, so a pair too far apart to fit at
 * it cannot be framed together; the built node wins then, being the thing the
 * press produced.
 * @param built - What the action produced: the node a press wrote, or the
 *   box {@link framedBox} picks from a paste's or duplicate's copies.
 * @param source - What it was made from, or null when none of that is on
 *   this canvas (a collaborator deleted it, the paste came from another Space,
 *   or the paste was text or a picture); what was produced is what has to be
 *   on screen.
 * @param viewport - What the reader can see, in canvas coordinates.
 * @returns The point to centre on, or null when nothing needs to move.
 */
export function frameBuiltNode(
  built: Rect,
  source: Rect | null,
  viewport: Rect,
): Point | null {
  if (contains(built, viewport)) return null;
  if (source === null) return centerOf(built);
  // No padding: this asks what the two nodes occupy, and a group's breathing
  // room would answer a different question.
  const both = groupRectForMembers([built, source], 0) ?? built;
  const fits = both.width <= viewport.width && both.height <= viewport.height;
  return centerOf(fits ? both : built);
}

/**
 * The box a paste or duplicate frames among its copies: all of them when they
 * fit the view together, else the first one. The middle of copies that do not
 * fit can be empty canvas, and framing it would put none of them on screen.
 * @param copies - Each copy's box, in canvas coordinates, in paste order.
 * @param viewport - What the reader can see, in canvas coordinates.
 * @returns The box to frame, or null when there are no copies.
 */
export function framedBox(copies: readonly Rect[], viewport: Rect): Rect | null {
  const all = groupRectForMembers(copies, 0);
  if (all === null) return null;
  return all.width <= viewport.width && all.height <= viewport.height ? all : (copies[0] ?? null);
}

/**
 * The box of the nodes a press just wrote, each at the footprint it was laid
 * out at: a node written this instant is not in ReactFlow's store yet to be
 * measured, and it holds that footprint until something lands in it.
 * @param built - Where the nodes were written and how large each is.
 * @returns The box around them.
 * @throws {never} Never.
 */
export function freshNodesBox(built: readonly [Rect, ...Rect[]]): Rect {
  const x = Math.min(...built.map((at) => at.x));
  const y = Math.min(...built.map((at) => at.y));
  return {
    x,
    y,
    width: Math.max(...built.map((at) => at.x + at.width)) - x,
    height: Math.max(...built.map((at) => at.y + at.height)) - y,
  };
}

/**
 * Where to move the camera after a press builds something to the right of the
 * node it was read from — a tool's result, a grid's group, an Understand
 * node (inner#1303). Nothing moves while what was built is in view; else the
 * camera slides at the reader's zoom, framing the source too when both fit;
 * what does not fit at that zoom is shown whole by zooming out just enough, as
 * a proposal is (`frameProposal`). It never zooms in.
 * @param built - What the press built, in canvas coordinates.
 * @param source - The node it was read from, or null when it is not on this canvas.
 * @param pane - The canvas pane's size in screen pixels.
 * @param pane.width - Its width.
 * @param pane.height - Its height.
 * @param now - The viewport the reader is at.
 * @returns The viewport to move to, or null to stay.
 * @throws {never} Never.
 */
export function viewportForBuilt(
  built: Rect,
  source: Rect | null,
  pane: { width: number; height: number },
  now: Viewport,
): Viewport | null {
  const { zoom } = now;
  if (zoom <= 0) return null;
  const view = { x: -now.x / zoom, y: -now.y / zoom, width: pane.width / zoom, height: pane.height / zoom };
  if (built.width > view.width || built.height > view.height) return frameProposal(built, pane, zoom);
  const at = frameBuiltNode(built, source, view);
  if (at === null) return null;
  return { x: pane.width / 2 - at.x * zoom, y: pane.height / 2 - at.y * zoom, zoom };
}

/**
 * Where to move the camera when a tool whose effect is seen in fine detail
 * opens on a node (the picture adjust, inner#1303 §6.1): close enough that the
 * node and its panel fill the view, and no closer than shows the picture at
 * its own pixels — the node then loads its full picture in place of the
 * thumbnail. The panel hangs under the node at its screen size whatever the
 * zoom, so only the node scales; centred under the node in the centred view,
 * it fits across whatever the zoom, so only its height takes part. A reader
 * already that close is left where they are; it never zooms out.
 * @param node - The node, in canvas coordinates.
 * @param panel - The panel under it, in screen pixels.
 * @param panel.height - Its height.
 * @param panel.gap - The space between the node and it.
 * @param pane - The canvas pane's size in screen pixels.
 * @param pane.width - Its width.
 * @param pane.height - Its height.
 * @param now - The viewport the reader is at.
 * @param oneToOne - The zoom at which the picture shows at its own pixels.
 * @returns The viewport to move to, or null to stay.
 * @throws {never} Never.
 */
export function viewportToInspect(
  node: Rect,
  panel: { height: number; gap: number },
  pane: { width: number; height: number },
  now: Viewport,
  oneToOne: number,
): Viewport | null {
  const across = pane.width * (1 - 2 * INSPECT_PADDING);
  const down = pane.height * (1 - 2 * INSPECT_PADDING);
  const zoom = Math.min(oneToOne, across / node.width, (down - panel.gap - panel.height) / node.height);
  if (zoom <= now.zoom) return null;
  const tall = node.height * zoom + panel.gap + panel.height;
  return {
    x: pane.width / 2 - (node.x + node.width / 2) * zoom,
    y: (pane.height - tall) / 2 - node.y * zoom,
    zoom,
  };
}

/** The gap kept between a box brought into view and the pane's edges or what floats over them. */
export const CHROME_GAP_PX = 24;

/**
 * Whether two rects share any area; touching edges do not.
 * @param a - One rect.
 * @param b - The other.
 * @returns True when they overlap.
 */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The shortest slide that puts a box inside a room and off every block: each
 * candidate edge is the box where it is, against a side of the room, or
 * against a side of a block.
 * @param box - The box.
 * @param room - Where it has to end up inside.
 * @param blocks - What it must not cover.
 * @returns The slide, or null when no candidate is clear.
 */
function clearSlide(box: Rect, room: Rect, blocks: readonly Rect[]): { dx: number; dy: number } | null {
  const xs = [box.x, room.x, room.x + room.width - box.width, ...blocks.flatMap((b) => [b.x - box.width, b.x + b.width])];
  const ys = [box.y, room.y, room.y + room.height - box.height, ...blocks.flatMap((b) => [b.y - box.height, b.y + b.height])];
  let best: { dx: number; dy: number } | null = null;
  for (const x of xs) {
    for (const y of ys) {
      const at = { ...box, x, y };
      if (!contains(at, room) || blocks.some((b) => overlaps(at, b))) continue;
      const dx = x - box.x;
      const dy = y - box.y;
      if (best === null || Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)) best = { dx, dy };
    }
  }
  return best;
}

/**
 * Where to slide the camera so a box on screen is in front of the reader
 * (inner#1345): nodes just placed and the generate panel opened on one of
 * them, grown around its prompt. The boxes come widest first, each one the
 * reader can do with less of. The first that can sit inside the pane, a gap
 * in from its edges and from the menu, toolbar and minimap floating over it,
 * is slid there the shortest way at the reader's zoom; when none can, the
 * last is put at the pane's top left. The panel keeps its size on screen, so
 * zooming out would not make it fit.
 * @param boxes - The boxes, widest first, in screen pixels from the pane's top left.
 * @param pane - The canvas pane's size in screen pixels.
 * @param pane.width - Its width.
 * @param pane.height - Its height.
 * @param now - The viewport the reader is at.
 * @param chrome - What floats over the pane, in the boxes' pixels.
 * @returns The viewport to move to, or null to stay.
 */
export function viewportToShow(
  boxes: readonly [Rect, ...Rect[]],
  pane: { width: number; height: number },
  now: Viewport,
  chrome: readonly Rect[],
): Viewport | null {
  const room = { x: CHROME_GAP_PX, y: CHROME_GAP_PX, width: pane.width - 2 * CHROME_GAP_PX, height: pane.height - 2 * CHROME_GAP_PX };
  const blocks = chrome
    .filter((one) => overlaps(one, { x: 0, y: 0, ...pane }))
    .map((one) => ({
      x: one.x - CHROME_GAP_PX,
      y: one.y - CHROME_GAP_PX,
      width: one.width + 2 * CHROME_GAP_PX,
      height: one.height + 2 * CHROME_GAP_PX,
    }));
  for (const box of boxes) {
    const slide = clearSlide(box, room, blocks);
    if (slide === null) continue;
    if (slide.dx === 0 && slide.dy === 0) return null;
    return { x: now.x + slide.dx, y: now.y + slide.dy, zoom: now.zoom };
  }
  const last = boxes[boxes.length - 1] ?? boxes[0];
  return { x: now.x + room.x - last.x, y: now.y + room.y - last.y, zoom: now.zoom };
}
