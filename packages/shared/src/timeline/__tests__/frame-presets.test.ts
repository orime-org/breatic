// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The fixed Timeline frame presets (#1502 design §2): seven aspect ratios with a short side of 1080, and the reverse
 * lookup from a document's stored size to its preset.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { TIMELINE_FRAME_PRESETS, timelineFramePresetOf } from "@shared/index.js";

const APPROVED = [
  ["16:9", { width: 1920, height: 1080 }],
  ["9:16", { width: 1080, height: 1920 }],
  ["1:1", { width: 1080, height: 1080 }],
  ["4:3", { width: 1440, height: 1080 }],
  ["4:5", { width: 1080, height: 1350 }],
  ["2:3", { width: 1080, height: 1620 }],
  ["21:9", { width: 2520, height: 1080 }],
] as const;

const FPS = { num: 24, den: 1 };

describe("TIMELINE_FRAME_PRESETS (#1502 design §2)", () => {
  it("lists exactly the seven approved presets with their sizes, in the approved order", () => {
    expect(Object.entries(TIMELINE_FRAME_PRESETS)).toEqual(APPROVED.map(([key, size]) => [key, size]));
  });

  it("gives every preset a short side of 1080", () => {
    for (const [, size] of APPROVED) expect(Math.min(size.width, size.height)).toBe(1080);
  });
});

describe("timelineFramePresetOf: the preset a stored size is (#1502 design §2)", () => {
  it.each(APPROVED)("reads %s from its exact size, whatever the frame rate", (key, size) => {
    expect(timelineFramePresetOf({ ...size, fps: FPS })).toBe(key);
    expect(timelineFramePresetOf({ ...size, fps: { num: 30000, den: 1001 } })).toBe(key);
  });

  it("reads a size with a preset's ratio but another size as no preset, the lookup being by exact size", () => {
    expect(timelineFramePresetOf({ width: 3840, height: 2160, fps: FPS })).toBe(undefined);
    expect(timelineFramePresetOf({ width: 1280, height: 720, fps: FPS })).toBe(undefined);
    expect(timelineFramePresetOf({ width: 2560, height: 1440, fps: FPS })).toBe(undefined);
  });

  it("reads any size outside the table as no preset", () => {
    const known = new Set(APPROVED.map(([, size]) => `${size.width}x${size.height}`));
    fc.assert(fc.property(fc.integer({ min: 1, max: 8192 }), fc.integer({ min: 1, max: 8192 }), (width, height) => {
      fc.pre(!known.has(`${width}x${height}`));
      return timelineFramePresetOf({ width, height, fps: FPS }) === undefined;
    }));
  });
});
