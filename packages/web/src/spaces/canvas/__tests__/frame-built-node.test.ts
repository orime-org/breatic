// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the canvas goes after a press writes a node beside another (#2175).
 *
 * Two ways to get this wrong, and they are opposites: never moving leaves a
 * press whose only effect is off-screen looking like a press that did
 * nothing, and always moving slides the canvas under a reader who could
 * already see everything.
 */

import { describe, expect, it } from 'vitest';

import { frameBuiltNode } from '@web/spaces/canvas/frame-built-node';

const VIEWPORT = { x: 0, y: 0, width: 1000, height: 800 };
/** A node near the right edge of what the reader can see. */
const SOURCE = { x: 650, y: 100, width: 288, height: 200 };
/** Where one step to the right of it lands: past that edge. */
const BUILT = { x: 962, y: 100, width: 288, height: 200 };

describe('framing the node a press just wrote', () => {
  it('moves nothing when the reader can already see it', () => {
    expect(
      frameBuiltNode(
        { x: 100, y: 100, width: 288, height: 200 },
        { x: 400, y: 100, width: 288, height: 200 },
        VIEWPORT,
      ),
    ).toBeNull();
  });

  // Partly visible is not visible: the reader sees a sliver of a node and
  // cannot read what landed in it.
  it('frames both nodes when the new one hangs over the edge', () => {
    // Both span x 650..1250 and y 100..300; the centre of that is the point.
    expect(frameBuiltNode(BUILT, SOURCE, VIEWPORT)).toEqual({
      x: 950,
      y: 200,
    });
  });

  // The zoom is the reader's and this does not touch it, so a pair too far
  // apart to fit at that zoom cannot be framed together. The press produced
  // the built node, so that is what has to be on screen.
  it('shows the new node alone when the pair does not fit', () => {
    const far = { x: -4000, y: 100, width: 288, height: 200 };

    expect(frameBuiltNode(BUILT, far, VIEWPORT)).toEqual({
      x: 1106,
      y: 200,
    });
  });

  // The canvas scrolls, so the viewport is rarely at the origin — a box is
  // judged against where the reader is looking, not against the canvas.
  it('judges against where the reader is looking', () => {
    expect(
      frameBuiltNode(BUILT, SOURCE, { x: 900, y: 0, width: 1000, height: 800 }),
    ).toBeNull();
  });
});
