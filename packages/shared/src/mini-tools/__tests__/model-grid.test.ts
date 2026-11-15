// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gridFrameSlot, gridSecondsAllowed, gridSlotFrame, modelGrid, presentationGridFrames } from "../model-grid.js";

/** Presentation frames of a constant-rate clip, as [displayStart, displayEnd) seconds. */
function cfr(count: number, rate: number, from = 0): { start: number; end: number }[] {
  return Array.from({ length: count }, (_, i) => ({ start: from + i / rate, end: from + (i + 1) / rate }));
}

/** Presentation frames whose stamps are rounded to a 1 ms time base, as a 29.97 fps MP4 stores them. */
function millisecondStamps(count: number, rate: number): { start: number; end: number }[] {
  const at = (i: number): number => Math.round((i * 1000) / rate) / 1000;
  return Array.from({ length: count }, (_, i) => ({ start: at(i), end: at(i + 1) }));
}

// Execution design §10.4 model grid row: at an average presentation rate of at most 30 fps the model input maps frame
// for frame; above it the range is resampled on a 30 fps grid. prepare, bria_mask and the composite share these.
describe("model grid (execution design §10.4)", () => {
  it("GR01 a 24 fps range maps frame for frame at its average rate", () => {
    const frames = cfr(120, 24);
    const grid = modelGrid(frames, 30);
    expect(grid).toEqual({ mode: "frames", rate: 24, frameCount: 120 });
    for (let i = 0; i < 120; i++) {
      expect(gridSlotFrame(grid, frames, i)).toBe(i);
      expect(gridFrameSlot(grid, frames, i)).toBe(i);
    }
  });

  it("GR02 a 29.97 fps range on a 1 ms time base keeps every frame in place", () => {
    const frames = millisecondStamps(150, 30000 / 1001);
    const grid = modelGrid(frames, 30);
    expect(grid.mode).toBe("frames");
    expect(grid.frameCount).toBe(150);
    frames.forEach((_, i) => {
      expect(gridSlotFrame(grid, frames, i)).toBe(i);
      expect(gridFrameSlot(grid, frames, i)).toBe(i);
    });
  });

  it("GR03 a jittery VFR range averaging under 30 fps maps frame for frame", () => {
    let at = 0.5;
    const frames = Array.from({ length: 60 }, (_, i) => {
      const length = i % 3 === 0 ? 1 / 20 : 1 / 30;
      const frame = { start: at, end: at + length };
      at += length;
      return frame;
    });
    const grid = modelGrid(frames, 30);
    expect(grid.mode).toBe("frames");
    expect(grid.frameCount).toBe(60);
    expect(grid.rate).toBeCloseTo(60 / (at - 0.5), 9);
    expect(gridSlotFrame(grid, frames, 37)).toBe(37);
  });

  it("GR04 a 60 fps range is resampled on the 30 fps grid", () => {
    const frames = cfr(120, 60, 3);
    const grid = modelGrid(frames, 30);
    expect(grid).toEqual({ mode: "resample", rate: 30, frameCount: 60 });
    for (let j = 0; j < 60; j++) expect(gridSlotFrame(grid, frames, j)).toBe(2 * j);
    expect(gridFrameSlot(grid, frames, 40)).toBe(20);
    expect(gridFrameSlot(grid, frames, 41)).toBe(20);
  });

  it("GR05 a resampled range that ends between grid times takes the ceiling slot count", () => {
    const frames = cfr(61, 60);
    const grid = modelGrid(frames, 30);
    expect(grid.frameCount).toBe(31);
    expect(gridSlotFrame(grid, frames, 30)).toBe(60);
    expect(gridFrameSlot(grid, frames, 60)).toBe(30);
  });

  it("GR06 resampling covers the range in order and each frame takes the last slot not after its start", () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 0.002, max: 0.05, noNaN: true }), { minLength: 2, maxLength: 300 }), fc.double({ min: 0, max: 100, noNaN: true }), (lengths, from) => {
      let at = from;
      const frames = lengths.map((length) => { const frame = { start: at, end: at + length }; at += length; return frame; });
      const grid = modelGrid(frames, 30);
      if (grid.mode !== "resample") return;
      let previous = 0;
      for (let j = 0; j < grid.frameCount; j++) {
        const index = gridSlotFrame(grid, frames, j);
        expect(index).toBeGreaterThanOrEqual(previous);
        expect(index).toBeLessThan(frames.length);
        previous = index;
      }
      frames.forEach((frame, i) => {
        const slot = gridFrameSlot(grid, frames, i);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(grid.frameCount);
        expect(from + slot / 30).toBeLessThanOrEqual(frame.start + 1e-9);
        if (slot + 1 < grid.frameCount) expect(from + (slot + 1) / 30).toBeGreaterThan(frame.start - 1e-9);
      });
    }));
  });

  it("GR07 the model input must last from min_seconds to max_seconds", () => {
    const bounds = { minSeconds: 1, maxSeconds: 5 };
    expect(gridSecondsAllowed(modelGrid(cfr(120, 24), 30), bounds)).toBe(true);
    expect(gridSecondsAllowed(modelGrid(cfr(24, 24), 30), bounds)).toBe(true);
    expect(gridSecondsAllowed(modelGrid(cfr(121, 24), 30), bounds)).toBe(false);
    expect(gridSecondsAllowed(modelGrid(cfr(23, 24), 30), bounds)).toBe(false);
  });
});

// A 60 fps WebM's frame starts are rounded to 1 ms (0, 17, 33, 50, 67 ms...): frame 4 truly starts at 66.67 ms, slot 2 of a
// 30 fps grid. Read through presentationGridFrames, every frame from the second on starts on its exact 60 fps grid point.
describe("a resample grid over starts rounded to the source clock (frames-split §7.17)", () => {
  const starts = Array.from({ length: 61 }, (_unused, k) => Math.round((k * 1000) / 60));
  const table = { schemaVersion: 1 as const, timescale: 1000, runs: starts.slice(0, 60).map((start, k) => ({ start, count: 1, step: starts[k + 1]! - start, duration: starts[k + 1]! - start })) };
  const frames = presentationGridFrames(table, 0, 60);
  const grid = { mode: "resample" as const, rate: 30, frameCount: 30 };

  it("MG09 every slot shows the frame starting on it: 0, 2, 4, ...", () => {
    expect(Array.from({ length: 30 }, (_unused, slot) => gridSlotFrame(grid, frames, slot))).toEqual(Array.from({ length: 30 }, (_unused, slot) => slot * 2));
  });

  it("MG10 each frame starting on a slot is placed on that slot", () => {
    expect(Array.from({ length: 30 }, (_unused, k) => gridFrameSlot(grid, frames, k * 2))).toEqual(Array.from({ length: 30 }, (_unused, k) => k));
  });

  it("MG11 the first frame keeps the presentation start, the last its end, and each frame ends where the next starts", () => {
    expect(frames[0]!.start).toBe(0);
    expect(frames[59]!.end).toBe(1);
    for (let k = 1; k < 60; k += 1) {
      expect(frames[k]!.start).toBeCloseTo(k / 60, 12);
      expect(frames[k - 1]!.end).toBe(frames[k]!.start);
    }
  });

  it("MG12 a range in the middle reads the same grid points as the whole table", () => {
    expect(presentationGridFrames(table, 20, 10)).toEqual(frames.slice(20, 30));
  });
});
