// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  TIMELINE_LAYER_TRANSFORM_LIMITS,
  timelineLayerBase,
  timelineLayerCorners,
  timelineLayerCss,
} from "@shared/index.js";

const CANVAS = { width: 1920, height: 1080 };
const IDENTITY = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

/**
 * Assert that two lists of points agree to floating-point precision.
 * @param actual - The computed points.
 * @param expected - The points the design defines.
 * @returns Nothing.
 * @throws {Error} When a coordinate differs beyond the precision.
 */
function expectPoints(actual: readonly { x: number; y: number }[], expected: readonly { x: number; y: number }[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((point, index) => {
    expect(actual[index]!.x).toBeCloseTo(point.x, 6);
    expect(actual[index]!.y).toBeCloseTo(point.y, 6);
  });
}

describe("timelineLayerBase: the source contained and centred in the canvas (#1410 design §2)", () => {
  it("fills the canvas when the source has the canvas aspect", () => {
    expect(timelineLayerBase(CANVAS, { width: 1280, height: 720 })).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("pillarboxes a portrait source: full height, centred horizontally", () => {
    expect(timelineLayerBase(CANVAS, { width: 1080, height: 1920 })).toEqual({ left: 656.25, top: 0, width: 607.5, height: 1080 });
  });

  it("letterboxes a wider source: full width, centred vertically", () => {
    expect(timelineLayerBase(CANVAS, { width: 3840, height: 1080 })).toEqual({ left: 0, top: 270, width: 1920, height: 540 });
  });

  it("uses the canvas size when either registered source dimension is empty", () => {
    const whole = { left: 0, top: 0, width: 1920, height: 1080 };
    expect(timelineLayerBase(CANVAS, { width: null, height: 1920 })).toEqual(whole);
    expect(timelineLayerBase(CANVAS, { width: 1080, height: null })).toEqual(whole);
    expect(timelineLayerBase(CANVAS, { width: null, height: null })).toEqual(whole);
  });
});

describe("timelineLayerCss: translate rotate scale, translation in display pixels (#1410 design §2)", () => {
  it("scales the canvas-pixel offset by the display factor and keeps rotation and scale as stored", () => {
    expect(timelineLayerCss({ x: 40, y: -20, scaleX: 1.5, scaleY: 0.5, rotation: 30 }, 0.5))
      .toBe("translate(20px, -10px) rotate(30deg) scale(1.5, 0.5)");
  });

  it("writes the default transform as no movement, so the element stays on its contained base box", () => {
    expect(timelineLayerCss(IDENTITY, 0.25)).toBe("translate(0px, 0px) rotate(0deg) scale(1, 1)");
  });
});

describe("timelineLayerCorners: the four corners after the transform, in canvas pixels (#1410 design §2)", () => {
  it("returns the base box corners for the default transform, the same as object-contain", () => {
    const base = timelineLayerBase(CANVAS, { width: 1080, height: 1920 });
    expectPoints(timelineLayerCorners(base, IDENTITY), [
      { x: 656.25, y: 0 }, { x: 1263.75, y: 0 }, { x: 1263.75, y: 1080 }, { x: 656.25, y: 1080 },
    ]);
  });

  it("moves the centre by (x, y) and scales width and height around it", () => {
    const base = { left: 0, top: 0, width: 1920, height: 1080 };
    expectPoints(timelineLayerCorners(base, { x: 100, y: -50, scaleX: 2, scaleY: 0.5, rotation: 0 }), [
      { x: -860, y: 220 }, { x: 2980, y: 220 }, { x: 2980, y: 760 }, { x: -860, y: 760 },
    ]);
  });

  it("rotates clockwise around the box centre", () => {
    const base = { left: 656.25, top: 0, width: 607.5, height: 1080 };
    // A quarter turn clockwise on screen (y down) takes the top-left corner to the upper right.
    expectPoints(timelineLayerCorners(base, { ...IDENTITY, rotation: 90 }), [
      { x: 1500, y: 236.25 }, { x: 1500, y: 843.75 }, { x: 420, y: 843.75 }, { x: 420, y: 236.25 },
    ]);
  });

  it("keeps the centre of the transformed corners at the base centre plus (x, y) for any accepted transform", () => {
    const size = fc.integer({ min: 1, max: 8192 });
    const scale = fc.double({ min: TIMELINE_LAYER_TRANSFORM_LIMITS.scale.min, max: TIMELINE_LAYER_TRANSFORM_LIMITS.scale.max, noNaN: true });
    fc.assert(fc.property(
      size, size, fc.option(size, { nil: null }), fc.option(size, { nil: null }),
      fc.double({ min: -10, max: 10, noNaN: true }), fc.double({ min: -10, max: 10, noNaN: true }),
      scale, scale, fc.double({ min: -180, max: 180, noNaN: true }),
      (width, height, sourceWidth, sourceHeight, xFactor, yFactor, scaleX, scaleY, rotation) => {
        const base = timelineLayerBase({ width, height }, { width: sourceWidth, height: sourceHeight });
        const x = xFactor * width;
        const y = yFactor * height;
        const corners = timelineLayerCorners(base, { x, y, scaleX, scaleY, rotation });
        const cx = corners.reduce((sum, point) => sum + point.x, 0) / corners.length;
        const cy = corners.reduce((sum, point) => sum + point.y, 0) / corners.length;
        const tolerance = 1e-9 * (width + height) * (1 + Math.max(scaleX, scaleY) + 10);
        return corners.length === 4
          && Math.abs(cx - (base.left + base.width / 2 + x)) <= tolerance
          && Math.abs(cy - (base.top + base.height / 2 + y)) <= tolerance;
      },
    ));
  });
});

describe("TIMELINE_LAYER_TRANSFORM_LIMITS: the range set_transform accepts (#1410 design §3.1)", () => {
  it("accepts scale 0.01..100, rotation -180..180 and offsets up to 10 canvas sizes", () => {
    expect(TIMELINE_LAYER_TRANSFORM_LIMITS).toMatchObject({
      scale: { min: 0.01, max: 100 },
      rotation: { min: -180, max: 180 },
      offsetCanvasMultiple: 10,
    });
  });
});
