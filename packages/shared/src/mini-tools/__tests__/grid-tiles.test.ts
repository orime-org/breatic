// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The grid is cut on the server (inner#1968 design 3.2.2, test spec B-12,
 * B-82, B-83). The tile geometry moves into shared so the browser that lays
 * out the result nodes and the container that cuts the picture use one
 * function: the i-th cut of a side sits at round(i x side / parts), the
 * browser's current rule. The grid becomes a container operation `grid` and
 * stays free, marked `billing: "free"` on its definition.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gridTileRects, miniToolById } from "@shared/mini-tools/index.js";

describe("B-83 gridTileRects", () => {
  it("cuts 1000 x 700 into 3 x 3 along x [0, 333, 667, 1000] and y [0, 233, 467, 700], row by row", () => {
    const rects = gridTileRects(1000, 700, 3, 3);
    expect(rects).toHaveLength(9);
    const xs = [0, 333, 667, 1000];
    const ys = [0, 233, 467, 700];
    rects.forEach((rect, index) => {
      const row = Math.floor(index / 3);
      const col = index % 3;
      expect(rect).toEqual({ x: xs[col], y: ys[row], width: xs[col + 1]! - xs[col]!, height: ys[row + 1]! - ys[row]! });
    });
  });

  it("covers every pixel of any picture exactly once, with no gap and no overlap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 4000 }),
        fc.integer({ min: 8, max: 4000 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        (width, height, rows, cols) => {
          const rects = gridTileRects(width, height, rows, cols);
          expect(rects).toHaveLength(rows * cols);
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              const tile = rects[row * cols + col]!;
              expect(tile.width).toBeGreaterThan(0);
              expect(tile.height).toBeGreaterThan(0);
              // Each tile starts where its left and upper neighbours end.
              expect(tile.x).toBe(col === 0 ? 0 : rects[row * cols + col - 1]!.x + rects[row * cols + col - 1]!.width);
              expect(tile.y).toBe(row === 0 ? 0 : rects[(row - 1) * cols + col]!.y + rects[(row - 1) * cols + col]!.height);
              expect(tile.x).toBe(Math.round((col * width) / cols));
              expect(tile.y).toBe(Math.round((row * height) / rows));
            }
            const last = rects[row * cols + cols - 1]!;
            expect(last.x + last.width).toBe(width);
          }
          const bottom = rects[(rows - 1) * cols]!;
          expect(bottom.y + bottom.height).toBe(height);
          expect(rects.reduce((area, r) => area + r.width * r.height, 0)).toBe(width * height);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("B-12 / B-82 the grid is a free container operation", () => {
  it("runs as the container operation grid, marked free, with its parameters and grouped grid output unchanged", () => {
    const spec = miniToolById("image.grid");
    expect(spec?.run).toEqual({ kind: "container", op: "grid" });
    expect(spec).toMatchObject({
      billing: "free",
      outputCount: { kind: "product", params: ["rows", "cols"], except: "skip" },
      outputLayout: "grid",
      groupOutputs: true,
    });
    expect(spec?.params.map((param) => param.key)).toEqual(["rows", "cols", "skip"]);
  });
});
