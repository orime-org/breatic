// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { gridTileRects } from '@web/spaces/canvas/mini-tool/grid-export';

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

  it('gives the pixels left over to the last row and the last column', () => {
    const rects = gridTileRects(500, 500, 8, 8);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 62, height: 62 });
    expect(rects[7]).toEqual({ x: 434, y: 0, width: 66, height: 62 });
    expect(rects[63]).toEqual({ x: 434, y: 434, width: 66, height: 66 });
  });

  it('covers every pixel exactly once', () => {
    const rects = gridTileRects(1037, 641, 7, 5);
    expect(rects.reduce((area, r) => area + r.width * r.height, 0)).toBe(1037 * 641);
    expect(Math.max(...rects.map((r) => r.x + r.width))).toBe(1037);
    expect(Math.max(...rects.map((r) => r.y + r.height))).toBe(641);
  });
});
