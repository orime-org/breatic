// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { videoExpandLayout } from "@breatic/shared/mini-tools";
import { expandBox, type PixelRect } from "../erase-expand-admission.js";

/**
 * Whether the inner rectangle lies inside the outer one.
 * @param inner - The inner rectangle.
 * @param outer - The outer rectangle.
 * @returns True when inside.
 * @throws {never} Never.
 */
function inside(inner: PixelRect, outer: PixelRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

// Execution design §10.5 standard frame row: the source rectangle is placed inside the target rectangle of the standard frame.
describe("expandBox keeps the source inside the target (execution design §10.5)", () => {
  it("EB01 a 1080x1920 source padded 456 px left stays inside the 480 px wide frame", () => {
    const source = { width: 1080, height: 1920 };
    const layout = videoExpandLayout({ x: -456 / 1080, y: 0, width: 1536 / 1080, height: 1 }, source, 4096);
    const box = expandBox(layout, source);
    expect(box.frame).toEqual({ width: 480, height: 832 });
    expect(box.sourceRoi.x + box.sourceRoi.width).toBeLessThanOrEqual(box.targetRoi.x + box.targetRoi.width);
    expect(inside(box.sourceRoi, box.targetRoi)).toBe(true);
  });

  const pad = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 2048 }));

  it("EB02 for any source and padding the source lies inside the target and the frame", () => {
    fc.assert(fc.property(
      // A video side of at least 64 px keeps the scaled source at least 2 px on each side of the standard frame.
      fc.integer({ min: 64, max: 2048 }), fc.integer({ min: 64, max: 2048 }),
      // Unpadded sides are common and are where the source touches the target's edge.
      pad, pad, pad, pad,
      (width, height, left, top, right, bottom) => {
        const source = { width, height };
        const frame = { x: -left / width, y: -top / height, width: (left + width + right) / width, height: (top + height + bottom) / height };
        const box = expandBox(videoExpandLayout(frame, source, Number.POSITIVE_INFINITY), source);
        expect(inside(box.sourceRoi, box.targetRoi)).toBe(true);
        expect(inside(box.targetRoi, { x: 0, y: 0, ...box.frame })).toBe(true);
      },
    ), { numRuns: 2000 });
  });
});
