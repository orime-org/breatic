// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where the grid tool's lines fall on its node (inner#1303 §6.4). The tiles
 * themselves are cut in the media container since inner#1968 (design 3.2.2),
 * with `gridTileRects` from `@breatic/shared/mini-tools`.
 */

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
