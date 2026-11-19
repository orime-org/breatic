// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gridFrameSlot, gridSecondsAllowed, gridSlotFrame, gridSpanFrames, modelGrid } from "../model-grid.js";

const fps = (numerator: number, denominator = 1): { numerator: number; denominator: number } => ({ numerator, denominator });

// Execution design §10.4 model grid row on the frame grid (frames-split §7.16): at a grid fps of at most 30 the model
// input maps frame for frame; above it the range is resampled on a 30 fps grid. prepare, bria_mask and the composite share these.
describe("model grid (execution design §10.4)", () => {
  it("GR01 a 24 fps range maps frame for frame at its grid fps", () => {
    const grid = modelGrid(120, fps(24), 30);
    expect(grid).toEqual({ mode: "frames", rate: 24, frameCount: 120 });
    for (let i = 0; i < 120; i++) {
      expect(gridSlotFrame(grid, fps(24), i)).toBe(i);
      expect(gridFrameSlot(grid, fps(24), i)).toBe(i);
    }
  });

  it("GR02 a 29.97 fps range keeps every frame in place", () => {
    const grid = modelGrid(150, fps(30000, 1001), 30);
    expect(grid).toEqual({ mode: "frames", rate: 30000 / 1001, frameCount: 150 });
  });

  it("GR04 a 60 fps range is resampled on the 30 fps grid", () => {
    const grid = modelGrid(120, fps(60), 30);
    expect(grid).toEqual({ mode: "resample", rate: 30, frameCount: 60 });
    for (let j = 0; j < 60; j++) expect(gridSlotFrame(grid, fps(60), j)).toBe(2 * j);
    expect(gridFrameSlot(grid, fps(60), 40)).toBe(20);
    expect(gridFrameSlot(grid, fps(60), 41)).toBe(20);
  });

  it("GR05 a resampled range that ends between model slots takes the ceiling slot count", () => {
    const grid = modelGrid(61, fps(60), 30);
    expect(grid.frameCount).toBe(31);
    expect(gridSlotFrame(grid, fps(60), 30)).toBe(60);
    expect(gridFrameSlot(grid, fps(60), 60)).toBe(30);
  });

  it("GR06 resampling covers the range in order and each frame takes the last slot not after its start", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 600 }), fc.integer({ min: 31, max: 240 }), fc.constantFrom(1, 1001), (count, numerator, denominator) => {
      const rate = fps(numerator * (denominator === 1001 ? 1000 : 1), denominator);
      const grid = modelGrid(count, rate, 30);
      if (grid.mode !== "resample") return;
      const perSecond = rate.numerator / rate.denominator;
      let previous = 0;
      for (let j = 0; j < grid.frameCount; j++) {
        const index = gridSlotFrame(grid, rate, j);
        expect(index).toBeGreaterThanOrEqual(previous);
        expect(index).toBeLessThan(count);
        previous = index;
      }
      for (let i = 0; i < count; i++) {
        const slot = gridFrameSlot(grid, rate, i);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(grid.frameCount);
        expect(slot / 30).toBeLessThanOrEqual(i / perSecond + 1e-9);
        if (slot + 1 < grid.frameCount) expect((slot + 1) / 30).toBeGreaterThan(i / perSecond - 1e-9);
      }
    }));
  });

  it("GR07 the model input must last from min_seconds to max_seconds", () => {
    const bounds = { minSeconds: 1, maxSeconds: 5 };
    expect(gridSecondsAllowed(modelGrid(120, fps(24), 30), bounds)).toBe(true);
    expect(gridSecondsAllowed(modelGrid(24, fps(24), 30), bounds)).toBe(true);
    expect(gridSecondsAllowed(modelGrid(121, fps(24), 30), bounds)).toBe(false);
    expect(gridSecondsAllowed(modelGrid(23, fps(24), 30), bounds)).toBe(false);
  });
});

// Execution design §10.5 on the grid: a window's span in grid seconds opens on the frame covering its start.
describe("a model window's grid frames (execution design §10.5)", () => {
  it("MG13 from the frame covering the span's start to the last frame starting before its end", () => {
    expect(gridSpanFrames({ start: 0.033, end: 0.2 }, fps(60), 60)).toEqual({ start: 1, end: 12 });
    expect(gridSpanFrames({ start: 1 / 30, end: 0.2 }, fps(60), 60)).toEqual({ start: 2, end: 12 });
    expect(gridSpanFrames({ start: 0.99, end: 2 }, fps(60), 60)).toEqual({ start: 59, end: 60 });
  });
});
