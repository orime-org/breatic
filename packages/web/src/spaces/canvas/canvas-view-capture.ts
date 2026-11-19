// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What of a canvas is on screen, for the capture an external agent asks for
 * (#1488 §19.1).
 */

/** A rectangle in flow coordinates. */
export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The flow area a viewport shows.
 * @param transform - The viewport's `[x, y, zoom]`.
 * @param box - The canvas box's size on screen.
 * @param box.width - Its width.
 * @param box.height - Its height.
 * @returns The area, in flow coordinates.
 */
export function flowAreaOnScreen(transform: readonly [number, number, number], box: { width: number; height: number }): FlowRect {
  const [tx, ty, zoom] = transform;
  return { x: -tx / zoom, y: -ty / zoom, width: box.width / zoom, height: box.height / zoom };
}

/**
 * The nodes any part of which is on screen.
 * @param nodes - Each node's id and rectangle in flow coordinates.
 * @param view - The flow area on screen.
 * @returns Their ids, in the order given.
 */
export function visibleNodeIds(nodes: ReadonlyArray<FlowRect & { id: string }>, view: FlowRect): string[] {
  return nodes
    .filter((n) => n.x < view.x + view.width && n.x + n.width > view.x && n.y < view.y + view.height && n.y + n.height > view.y)
    .map((n) => n.id);
}
