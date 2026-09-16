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
 * A group reads as a flow, and a flow reads left to right, so the first node
 * takes the centre and the rest follow along one row. One row is what lets the
 * reader see the whole group without panning.
 * @param count - How many nodes are being placed.
 * @param centre - The viewport centre, in flow coordinates.
 * @param step - How far apart two neighbours sit.
 * @returns One spot per node, in the same order.
 * @throws {never} Never.
 */
export function placeLeftToRight(count: number, centre: Spot, step: number): Spot[] {
  return Array.from({ length: count }, (_, i) => ({
    x: centre.x + i * step,
    y: centre.y,
  }));
}
