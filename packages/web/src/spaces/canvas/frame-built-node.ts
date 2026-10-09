// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where to move the canvas after a press writes a node beside another one.
 *
 * A node written one step to the right of the one being read is off-screen on
 * a canvas scrolled near its right edge, and a press whose only effect is
 * off-screen looks like a press that did nothing. Moving every time is the
 * other half of that: a reader who can already see both nodes has the canvas
 * slide under them for no reason they can name.
 */

import {
  centerOf,
  groupRectForMembers,
  type Point,
  type Rect,
} from '@web/spaces/canvas/group-geometry';

/** How long the canvas takes to slide what an action just made into view. */
export const FRAME_PAN_MS = 300;

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
