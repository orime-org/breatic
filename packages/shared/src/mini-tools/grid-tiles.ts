// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** One tile of a grid cut, in source pixels. */
export interface GridTileRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the grid tool cuts a picture (inner#1968, design 3.2.2): the i-th cut
 * of a side sits at `round(i × side / parts)`, so the tiles cover every pixel
 * once. The browser lays the result nodes out with it and the container cuts
 * with it, so both agree.
 * @param width - The picture's width.
 * @param height - The picture's height.
 * @param rows - How many rows.
 * @param cols - How many columns.
 * @returns The tiles, row by row.
 */
export function gridTileRects(width: number, height: number, rows: number, cols: number): GridTileRect[] {
  const tiles: GridTileRect[] = [];
  for (let row = 0; row < rows; row++) {
    const y = Math.round((row * height) / rows);
    const bottom = Math.round(((row + 1) * height) / rows);
    for (let col = 0; col < cols; col++) {
      const x = Math.round((col * width) / cols);
      const right = Math.round(((col + 1) * width) / cols);
      tiles.push({ x, y, width: right - x, height: bottom - y });
    }
  }
  return tiles;
}
