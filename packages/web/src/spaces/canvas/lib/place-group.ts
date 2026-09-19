// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a proposed group of nodes lands on the canvas (#229).
 *
 * The card that proposes a group has no viewport, so it posts the group and
 * the canvas decides the spots. Kept apart from the placing itself so the
 * arrangement can be held by a test without a canvas around it.
 */

/** A point in flow coordinates. */
export interface Spot {
  x: number;
  y: number;
}

/**
 * Where each node of a group goes, in the order the proposal lists them.
 *
 * A group reads as a flow, and a flow reads left to right, so the nodes take
 * one row. The row is centred on the point rather than started at it: what
 * the reader was looking at is the middle of what they get, and a row laid
 * out rightwards from the centre walks its last node -- the one that
 * generates, the one they were handed -- off the right edge.
 * @param count - How many nodes are being placed.
 * @param centre - The viewport centre, in flow coordinates.
 * @param step - How far apart two neighbours sit.
 * @returns One spot per node, in the same order.
 * @throws {never} Never.
 */
export function placeLeftToRight(count: number, centre: Spot, step: number): Spot[] {
  const start = centre.x - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => ({
    x: start + i * step,
    y: centre.y,
  }));
}
