// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tile arithmetic of cutting a picture into a grid (inner#1303 §6.4); the
 * raster half lives in web's `grid-export.ts`.
 */

import type { Rect } from '@shared/canvas/model/group-geometry.js';

/**
 * Where a side is cut into equal parts: the i-th cut at round(i × side /
 * parts), so the parts are at most a pixel apart and each cut sits where an
 * even split of the side draws its line.
 * @param side - The side in pixels.
 * @param parts - How many parts.
 * @returns The cuts from 0 to `side`, one more than `parts`.
 */
export function gridCuts(side: number, parts: number): number[] {
  return Array.from({ length: parts + 1 }, (_, i) => Math.round((i * side) / parts));
}

/**
 * The tiles of a picture cut into equal rows and columns, row by row, along
 * `gridCuts`.
 * @param width - The picture's width in pixels.
 * @param height - Its height in pixels.
 * @param rows - Rows.
 * @param cols - Columns.
 * @returns One rectangle per tile, in source pixels.
 */
export function gridTileRects(width: number, height: number, rows: number, cols: number): Rect[] {
  const xs = gridCuts(width, cols);
  const ys = gridCuts(height, rows);
  const rects: Rect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = xs[col] ?? 0;
      const y = ys[row] ?? 0;
      rects.push({ x, y, width: (xs[col + 1] ?? width) - x, height: (ys[row + 1] ?? height) - y });
    }
  }
  return rects;
}
