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
 * @param built - The node this press wrote.
 * @param source - The node it was read from, or null when a collaborator
 *   deleted it while the menu stood open — the press still produced a node,
 *   and that node is what has to be on screen.
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
