// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { gridCuts, gridTileRects } from '@web/spaces/canvas/mini-tool/grid-export';

describe('gridTileRects', () => {
  it('cuts an even picture into equal tiles, row by row', () => {
    expect(gridTileRects(600, 400, 2, 3)).toEqual([
      { x: 0, y: 0, width: 200, height: 200 },
      { x: 200, y: 0, width: 200, height: 200 },
      { x: 400, y: 0, width: 200, height: 200 },
      { x: 0, y: 200, width: 200, height: 200 },
      { x: 200, y: 200, width: 200, height: 200 },
      { x: 400, y: 200, width: 200, height: 200 },
    ]);
  });

  // §6.4: the i-th cut sits at round(i × side / parts), where the node draws its
  // i-th line, so no tile is more than a pixel off the others.
  it('spreads the pixels left over across the tiles, a pixel at most apart', () => {
    const rects = gridTileRects(1007, 1007, 8, 8);
    expect(rects[7]).toEqual({ x: 881, y: 0, width: 126, height: 126 });
    const widths = rects.slice(0, 8).map((r) => r.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  it('places each cut where an even split of the side would', () => {
    expect(gridCuts(1007, 8)).toEqual([0, 126, 252, 378, 504, 629, 755, 881, 1007]);
  });

  it('covers every pixel exactly once', () => {
    const rects = gridTileRects(1037, 641, 7, 5);
    expect(rects.reduce((area, r) => area + r.width * r.height, 0)).toBe(1037 * 641);
    expect(Math.max(...rects.map((r) => r.x + r.width))).toBe(1037);
    expect(Math.max(...rects.map((r) => r.y + r.height))).toBe(641);
  });
});
