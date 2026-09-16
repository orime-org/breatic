// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a proposed group lands on the canvas (#229).
 *
 * The reader presses a card and expects to see the whole group at once. That
 * only holds if the nodes sit on one row starting at what they were looking
 * at -- stack them and the group reads as one node with the rest off-screen.
 */

import { describe, it, expect } from 'vitest';

import { placeLeftToRight } from '@web/spaces/canvas/lib/place-group';

describe('where a proposal lands', () => {
  it('starts at the viewport centre and steps right', () => {
    const spots = placeLeftToRight(2, { x: 100, y: 40 }, 360);

    expect(spots).toEqual([
      { x: 100, y: 40 },
      { x: 460, y: 40 },
    ]);
  });

  it('keeps every node on one row', () => {
    const spots = placeLeftToRight(4, { x: 0, y: 12 }, 50);

    expect(spots.map((s) => s.y)).toEqual([12, 12, 12, 12]);
  });

  it('places a lone node at the centre itself', () => {
    expect(placeLeftToRight(1, { x: 7, y: 9 }, 360)).toEqual([{ x: 7, y: 9 }]);
  });
});
