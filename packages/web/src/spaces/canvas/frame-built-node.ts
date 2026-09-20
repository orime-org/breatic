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

/** A box in canvas coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Whether one box lies entirely within another.
 * @param inner - The box being looked for.
 * @param outer - The box being looked in.
 * @returns True when every edge of `inner` is inside `outer`.
 */
function contains(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * The centre of a box.
 * @param box - The box.
 * @returns Its centre point.
 */
function centreOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The smallest box holding both.
 * @param a - One box.
 * @param b - The other.
 * @returns The box covering both.
 */
function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
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
  built: Box,
  source: Box | null,
  viewport: Box,
): { x: number; y: number } | null {
  if (contains(built, viewport)) return null;
  if (source === null) return centreOf(built);
  const both = union(built, source);
  const fits = both.width <= viewport.width && both.height <= viewport.height;
  return centreOf(fits ? both : built);
}
