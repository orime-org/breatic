// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cutting a picture into a grid of tiles in the browser (inner#1303 §6.4).
 * The tile arithmetic is pure; the raster half is covered by the real-browser
 * smoke, since jsdom has no image decode.
 */

import type { CropRect } from '@web/lib/crop-math';
import { pngOf, prepareCropSource, type CropSource } from '@web/spaces/canvas/focus/crop-export';
import { intrinsicSize } from '@web/spaces/canvas/focus/crop-source';

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
export function gridTileRects(width: number, height: number, rows: number, cols: number): CropRect[] {
  const xs = gridCuts(width, cols);
  const ys = gridCuts(height, rows);
  const rects: CropRect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = xs[col] ?? 0;
      const y = ys[row] ?? 0;
      rects.push({ x, y, width: (xs[col + 1] ?? width) - x, height: (ys[row + 1] ?? height) - y });
    }
  }
  return rects;
}

/**
 * Cut the source into a grid and export the given tiles as PNGs at source
 * resolution, in the order given.
 * @param source - The picture.
 * @param rows - Rows.
 * @param cols - Columns.
 * @param cells - The tiles to export, by row-major index.
 * @returns Each exported tile's PNG and pixel size, in the order of `cells`.
 * @throws {Error} When the source fails to load CORS-clean, or a canvas cannot export.
 */
export async function exportGridTiles(
  source: CropSource,
  rows: number,
  cols: number,
  cells: readonly number[],
): Promise<{ blob: Blob; width: number; height: number }[]> {
  const el = await prepareCropSource(source);
  const { width, height } = intrinsicSize(el);
  const rects = gridTileRects(width, height, rows, cols);
  const tiles: { blob: Blob; width: number; height: number }[] = [];
  for (const rect of cells.map((cell) => rects[cell]!)) {
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(el, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    tiles.push({ blob: await pngOf(canvas), width: rect.width, height: rect.height });
  }
  return tiles;
}
