// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a proposed group lands on the canvas (#229).
 *
 * The reader presses a card and expects to see the whole group at once. That
 * only holds if the nodes sit on one row AND the row is centred on what they
 * were looking at -- stack them and the group reads as one node; start the
 * row at the centre and a three-node group puts the one that generates, the
 * one the reader is being handed, off past the right edge.
 */

import { describe, it, expect } from 'vitest';

import { placeLeftToRight } from '@web/spaces/canvas/lib/place-group';

describe('where a proposal lands', () => {
  it('centres the row on the viewport centre and steps right', () => {
    const spots = placeLeftToRight(2, { x: 100, y: 40 }, 360);

    expect(spots).toEqual([
      { x: -80, y: 40 },
      { x: 280, y: 40 },
    ]);
  });

  it('keeps the middle of the row on the point it was given', () => {
    // What the reader was looking at is what the group has to be built
    // around: three nodes laid out from the centre rightwards put the last
    // one two full steps away, which is off-screen on a common window.
    const spots = placeLeftToRight(3, { x: 0, y: 0 }, 360);

    expect(spots.map((s) => s.x)).toEqual([-360, 0, 360]);
    const middle = ((spots[0] as { x: number }).x + (spots[2] as { x: number }).x) / 2;
    expect(middle).toBe(0);
  });

  it('keeps every node on one row', () => {
    const spots = placeLeftToRight(4, { x: 0, y: 12 }, 50);

    expect(spots.map((s) => s.y)).toEqual([12, 12, 12, 12]);
  });

  it('places a lone node at the centre itself', () => {
    expect(placeLeftToRight(1, { x: 7, y: 9 }, 360)).toEqual([{ x: 7, y: 9 }]);
  });
});
