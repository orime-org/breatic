// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Cutting a picture into a grid of tiles in the browser (inner#1303 §6.4).
 * The tile arithmetic is `gridTileRects` in `@breatic/shared/canvas-model`;
 * the raster half here is covered by the real-browser smoke, since jsdom has
 * no image decode.
 */

import { gridCuts, gridTileRects } from '@breatic/shared/canvas-model';
import { pngOf, prepareCropSource, type CropSource } from '@web/spaces/canvas/focus/crop-export';
import { intrinsicSize } from '@web/spaces/canvas/focus/crop-source';

export { gridCuts, gridTileRects };

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
