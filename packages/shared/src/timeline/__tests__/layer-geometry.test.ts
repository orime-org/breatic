// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  TIMELINE_LAYER_TRANSFORM_LIMITS,
  normalizeTimelineLayerTransform,
  sameTimelineLayerTransform,
  timelineLayerBase,
  timelineLayerContains,
  timelineLayerCorners,
  timelineLayerFrameOffset,
  timelineLayerOffsetPixels,
  timelineLayerStyle,
  type TimelineLayerBox,
  type TimelineLayerTransform,
} from "@shared/index.js";

const CANVAS = { width: 1920, height: 1080 };
/** The preset sizes of #1502 design §2, written out so this file does not depend on the preset module. */
const FRAMES = {
  "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 }, "4:5": { width: 1080, height: 1350 }, "2:3": { width: 1080, height: 1620 },
  "21:9": { width: 2520, height: 1080 },
} as const;
const IDENTITY = { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 };

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

/**
 * Where the browser draws the corners of an element styled by `timelineLayerStyle`: the box from left, top, width and
 * height, transformed by translate, rotate and scale about its `transform-origin` keywords. The translation is the
 * frame offset times the frame size (#1502 design §4).
 * @param frame - The Timeline frame size in canvas pixels.
 * @param frame.width - Frame width.
 * @param frame.height - Frame height.
 * @param base - The layer's base box in canvas pixels.
 * @param transform - The placement the style was built from.
 * @param factor - Display pixels per canvas pixel.
 * @returns The four corners in display pixels, in `timelineLayerCorners` order.
 * @throws {Error} When the origin holds a keyword this helper does not know.
 */
function styledCorners(frame: { width: number; height: number }, base: TimelineLayerBox, transform: TimelineLayerTransform, factor: number): { x: number; y: number }[] {
  const style = timelineLayerStyle(frame, base, transform, factor);
  const [left, top, width, height] = [style.left, style.top, style.width, style.height].map((value) => Number.parseFloat(value)) as [number, number, number, number];
  const at = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 } as const;
  const words = style.transformOrigin.split(/\s+/) as (keyof typeof at)[];
  if (words.some((word) => !(word in at))) throw new Error(`Unknown transform-origin ${style.transformOrigin}`);
  const horizontal = words.find((word) => word === "left" || word === "right") ?? "center";
  const vertical = words.find((word) => word === "top" || word === "bottom") ?? "center";
  const ox = left + at[horizontal] * width;
  const oy = top + at[vertical] * height;
  const angle = (transform.rotation * Math.PI) / 180;
  return [[left, top], [left + width, top], [left + width, top + height], [left, top + height]].map(([px, py]) => {
    const dx = (px! - ox) * transform.scaleX;
    const dy = (py! - oy) * transform.scaleY;
    return {
      x: ox + transform.frameX * frame.width * factor + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: oy + transform.frameY * frame.height * factor + dx * Math.sin(angle) + dy * Math.cos(angle),
    };
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

  it("uses the canvas size when either registered source dimension is zero", () => {
    const whole = { left: 0, top: 0, width: 1920, height: 1080 };
    expect(timelineLayerBase(CANVAS, { width: 0, height: 1920 })).toEqual(whole);
    expect(timelineLayerBase(CANVAS, { width: 1080, height: 0 })).toEqual(whole);
  });
});

describe("timelineLayerStyle: translate rotate scale, translation in display pixels (#1410 design §2, #1502 design §4)", () => {
  it("turns the frame offset into canvas pixels by the frame size, then into display pixels by the factor", () => {
    expect(timelineLayerStyle(CANVAS, timelineLayerBase(CANVAS, { width: null, height: null }), { frameX: 0.25, frameY: -0.5, scaleX: 1.5, scaleY: 0.5, rotation: 30 }, 0.5).transform)
      .toBe("translate(240px, -270px) rotate(30deg) scale(1.5, 0.5)");
  });

  it("moves the same offset by the other frame's size in a portrait frame", () => {
    const portrait = FRAMES["9:16"];
    expect(timelineLayerStyle(portrait, timelineLayerBase(portrait, { width: null, height: null }), { frameX: 0.25, frameY: -0.5, scaleX: 1, scaleY: 1, rotation: 0 }, 0.5).transform)
      .toBe("translate(135px, -480px) rotate(0deg) scale(1, 1)");
  });

  it("writes the default transform as no movement, so the element stays on its contained base box", () => {
    expect(timelineLayerStyle(CANVAS, timelineLayerBase(CANVAS, { width: null, height: null }), IDENTITY, 0.25).transform).toBe("translate(0px, 0px) rotate(0deg) scale(1, 1)");
  });

  it("draws the element's corners where timelineLayerCorners puts them, rotating and scaling about the box centre", () => {
    const base = timelineLayerBase(CANVAS, { width: 1080, height: 1920 });
    const transform = { frameX: 0.05, frameY: -0.05, scaleX: 1.5, scaleY: 0.5, rotation: 30 };
    expectPoints(styledCorners(CANVAS, base, transform, 0.5), timelineLayerCorners(CANVAS, base, transform).map((point) => ({ x: point.x * 0.5, y: point.y * 0.5 })));
  });
});

describe("timelineLayerCorners: the four corners after the transform, in canvas pixels (#1410 design §2)", () => {
  it("returns the base box corners for the default transform, the same as object-contain", () => {
    const base = timelineLayerBase(CANVAS, { width: 1080, height: 1920 });
    expectPoints(timelineLayerCorners(CANVAS, base, IDENTITY), [
      { x: 656.25, y: 0 }, { x: 1263.75, y: 0 }, { x: 1263.75, y: 1080 }, { x: 656.25, y: 1080 },
    ]);
  });

  it("moves the centre by (frameX x frame width, frameY x frame height) and scales width and height around it", () => {
    const base = { left: 0, top: 0, width: 1920, height: 1080 };
    expectPoints(timelineLayerCorners(CANVAS, base, { frameX: 0.125, frameY: -0.25, scaleX: 2, scaleY: 0.5, rotation: 0 }), [
      { x: -720, y: 0 }, { x: 3120, y: 0 }, { x: 3120, y: 540 }, { x: -720, y: 540 },
    ]);
  });

  it("rotates clockwise around the box centre", () => {
    const base = { left: 656.25, top: 0, width: 607.5, height: 1080 };
    // A quarter turn clockwise on screen (y down) takes the top-left corner to the upper right.
    expectPoints(timelineLayerCorners(CANVAS, base, { ...IDENTITY, rotation: 90 }), [
      { x: 1500, y: 236.25 }, { x: 1500, y: 843.75 }, { x: 420, y: 843.75 }, { x: 420, y: 236.25 },
    ]);
  });

  it("keeps the centre of the transformed corners at the base centre plus the offset in frame pixels for any accepted transform", () => {
    const size = fc.integer({ min: 1, max: 8192 });
    const scale = fc.double({ min: TIMELINE_LAYER_TRANSFORM_LIMITS.scale.min, max: TIMELINE_LAYER_TRANSFORM_LIMITS.scale.max, noNaN: true });
    fc.assert(fc.property(
      size, size, fc.option(size, { nil: null }), fc.option(size, { nil: null }),
      fc.double({ min: -10, max: 10, noNaN: true }), fc.double({ min: -10, max: 10, noNaN: true }),
      scale, scale, fc.double({ min: -180, max: 180, noNaN: true }),
      (width, height, sourceWidth, sourceHeight, frameX, frameY, scaleX, scaleY, rotation) => {
        const base = timelineLayerBase({ width, height }, { width: sourceWidth, height: sourceHeight });
        const x = frameX * width;
        const y = frameY * height;
        const corners = timelineLayerCorners({ width, height }, base, { frameX, frameY, scaleX, scaleY, rotation });
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

describe("timelineLayerContains: the hit test on the transformed corners (#1410 design §4.2)", () => {
  const corners = timelineLayerCorners({ width: 100, height: 50 }, { left: 0, top: 0, width: 100, height: 50 }, IDENTITY);

  it("counts a point on an edge or on a corner as inside", () => {
    expect(timelineLayerContains(corners, { x: 100, y: 25 })).toBe(true);
    expect(timelineLayerContains(corners, { x: 50, y: 50 })).toBe(true);
    expect(timelineLayerContains(corners, { x: 100, y: 50 })).toBe(true);
  });

  it("counts a point just outside an edge as outside", () => {
    expect(timelineLayerContains(corners, { x: 100.01, y: 25 })).toBe(false);
  });
});

describe("normalizeTimelineLayerTransform: what a sender sends (#1410 design §3.1)", () => {
  it("keeps 180 degrees as 180 and sends -180 as 180, the range being above -180 and at most 180", () => {
    expect(normalizeTimelineLayerTransform({ ...IDENTITY, rotation: 180 }).rotation).toBe(180);
    expect(normalizeTimelineLayerTransform({ ...IDENTITY, rotation: -180 }).rotation).toBe(180);
    expect(normalizeTimelineLayerTransform({ ...IDENTITY, rotation: 540 }).rotation).toBe(180);
  });

  it("clamps each scale axis to the accepted range", () => {
    const { min, max } = TIMELINE_LAYER_TRANSFORM_LIMITS.scale;
    expect(normalizeTimelineLayerTransform({ ...IDENTITY, scaleX: 0.001, scaleY: 250 })).toMatchObject({ scaleX: min, scaleY: max });
    expect(normalizeTimelineLayerTransform({ ...IDENTITY, scaleX: 250, scaleY: 0.001 })).toMatchObject({ scaleX: max, scaleY: min });
  });

  it("rounds each frame offset to 0.00001 of the frame and sends no pixel field (#1502 design §4)", () => {
    const sent = normalizeTimelineLayerTransform({ ...IDENTITY, frameX: 0.123456789, frameY: -0.333333333 });
    expect(sent).toEqual({ frameX: 0.12346, frameY: -0.33333, scaleX: 1, scaleY: 1, rotation: 0 });
  });
});

describe("sameTimelineLayerTransform compares the frame offsets (#1502 design §4)", () => {
  it("tells two placements apart by frameX or frameY alone", () => {
    expect(sameTimelineLayerTransform({ ...IDENTITY, frameX: 0.1 }, { ...IDENTITY, frameX: 0.2 })).toBe(false);
    expect(sameTimelineLayerTransform({ ...IDENTITY, frameY: 0.1 }, { ...IDENTITY, frameY: 0.2 })).toBe(false);
    expect(sameTimelineLayerTransform({ ...IDENTITY, frameX: 0.1 }, { ...IDENTITY, frameX: 0.1 })).toBe(true);
  });
});

describe("frame offsets and canvas pixels (#1502 design §4)", () => {
  it("places the design's picture-in-picture example: (0.35, -0.35) in a 9:16 frame is (378, -672) canvas pixels", () => {
    const point = timelineLayerOffsetPixels(FRAMES["9:16"], { frameX: 0.35, frameY: -0.35 });
    expect(point.x).toBeCloseTo(378, 9);
    expect(point.y).toBeCloseTo(-672, 9);
  });

  it("measures the offset from the frame centre: the right edge is frameX 0.5 and the top edge frameY -0.5", () => {
    expect(timelineLayerFrameOffset(CANVAS, { x: 960, y: -540 })).toEqual({ frameX: 0.5, frameY: -0.5 });
    expect(timelineLayerOffsetPixels(CANVAS, { frameX: 0.5, frameY: -0.5 })).toEqual({ x: 960, y: -540 });
  });

  it("keeps a layer's centre at the same place relative to the frame in every preset", () => {
    const presets = Object.values(FRAMES);
    fc.assert(fc.property(
      fc.constantFrom(...presets), fc.constantFrom(...presets),
      fc.double({ min: -10, max: 10, noNaN: true }), fc.double({ min: -10, max: 10, noNaN: true }),
      (from, to, frameX, frameY) => {
        const transform = { ...IDENTITY, frameX, frameY };
        const relative = (frame: { width: number; height: number }): { x: number; y: number } => {
          const corners = timelineLayerCorners(frame, timelineLayerBase(frame, { width: 1280, height: 720 }), transform);
          const cx = corners.reduce((sum, point) => sum + point.x, 0) / 4;
          const cy = corners.reduce((sum, point) => sum + point.y, 0) / 4;
          return { x: (cx - frame.width / 2) / frame.width, y: (cy - frame.height / 2) / frame.height };
        };
        const a = relative(from);
        const b = relative(to);
        return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9;
      },
    ));
  });

  it("reads every whole-pixel offset back unchanged at the widest preset, 2520 wide, after the sender rounds it", () => {
    const frame = FRAMES["21:9"];
    expect(frame.width).toBe(2520);
    for (let pixel = -2520; pixel <= 2520; pixel += 1) {
      const sent = normalizeTimelineLayerTransform({ ...IDENTITY, ...timelineLayerFrameOffset(frame, { x: pixel, y: pixel }) });
      const back = timelineLayerOffsetPixels(frame, sent);
      expect(Math.round(back.x)).toBe(pixel);
      expect(Math.round(back.y)).toBe(pixel);
    }
  });

  it("round-trips any whole-pixel offset within the limit in any preset, off by at most half a rounding step", () => {
    fc.assert(fc.property(
      fc.constantFrom(...Object.values(FRAMES)), fc.integer({ min: -10, max: 10 }), fc.integer({ min: -10, max: 10 }),
      fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }),
      (frame, wholeX, wholeY, partX, partY) => {
        const x = Math.round((wholeX + partX) * frame.width);
        const y = Math.round((wholeY + partY) * frame.height);
        const sent = normalizeTimelineLayerTransform({ ...IDENTITY, ...timelineLayerFrameOffset(frame, { x, y }) });
        const back = timelineLayerOffsetPixels(frame, sent);
        const step = TIMELINE_LAYER_TRANSFORM_LIMITS.precision.offset;
        return Math.round(back.x) === x && Math.round(back.y) === y
          && Math.abs(back.x - x) <= (step / 2) * frame.width + 1e-6 && Math.abs(back.y - y) <= (step / 2) * frame.height + 1e-6;
      },
    ));
  });
});

describe("TIMELINE_LAYER_TRANSFORM_LIMITS: the range set_transform accepts (#1410 design §3.1, #1502 design §4)", () => {
  it("accepts scale 0.01..100, rotation -180..180 and frame offsets up to ±10 frame sizes, rounded to 0.00001", () => {
    expect(TIMELINE_LAYER_TRANSFORM_LIMITS).toMatchObject({
      scale: { min: 0.01, max: 100 },
      rotation: { min: -180, max: 180 },
      offsetCanvasMultiple: 10,
      precision: { offset: 0.00001, scale: 0.0001, rotation: 0.01 },
    });
  });
});
