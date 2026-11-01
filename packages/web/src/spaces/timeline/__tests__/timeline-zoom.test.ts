// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Zoom bounds and ruler label spacing for any Timeline length (inner#1708 G4, R1). */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { timelineMinZoom, timelineRulerStep } from '@web/spaces/timeline/timeline-zoom';

/** The zoom slider's upper bound in pixels per frame. */
const MAX_ZOOM = 12;
const LABEL_GAP_PX = 48;
const MAX_LABELS = 400;

/**
 * How many ruler labels a step draws from second 0 to the end of the extent.
 * @param fps - The Timeline frames per second.
 * @param extentFrames - The scrollable length.
 * @param step - The label step in seconds.
 * @returns The label count.
 * @throws {never} Never.
 */
function labelCount(fps: number, extentFrames: number, step: number): number {
  return Math.floor(extentFrames / fps / step) + 1;
}

describe('timelineMinZoom', () => {
  it('fits the whole extent into the viewport', () => {
    expect(timelineMinZoom(4000, 1000)).toBeCloseTo(0.25);
    expect(timelineMinZoom(1_000_000, 1000)).toBeCloseTo(0.001);
  });

  it('never exceeds the maximum zoom for a short Timeline', () => {
    expect(timelineMinZoom(10, 1000)).toBe(MAX_ZOOM);
    expect(timelineMinZoom(1, 5000)).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('stays positive and finite for any extent', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), fc.integer({ min: 100, max: 4000 }), (extent, viewport) => {
      const zoom = timelineMinZoom(extent, viewport);
      expect(Number.isFinite(zoom)).toBe(true);
      expect(zoom).toBeGreaterThan(0);
      expect(zoom).toBeLessThanOrEqual(MAX_ZOOM);
      if (viewport / extent <= MAX_ZOOM) expect(zoom * extent).toBeCloseTo(viewport);
    }));
  });
});

describe('timelineRulerStep', () => {
  const FPS30 = 30;

  it('labels every second when seconds are far enough apart', () => {
    expect(timelineRulerStep(FPS30, 2, 3000)).toBe(1);
  });

  it('widens the step so labels keep their gap when zoomed out', () => {
    const step = timelineRulerStep(FPS30, 0.25, 3000);
    expect(step * 30 * 0.25).toBeGreaterThanOrEqual(LABEL_GAP_PX);
  });

  it('caps the label count for a very long extent without throwing', () => {
    for (const extent of [1e10, 9e15]) {
      const step = timelineRulerStep(FPS30, 2, extent);
      expect(Number.isFinite(step)).toBe(true);
      expect(labelCount(FPS30, extent, step)).toBeLessThanOrEqual(MAX_LABELS);
    }
  });

  it('keeps labels at least 48 px apart and at most 400 over any extent', () => {
    fc.assert(fc.property(
      fc.constantFrom(24, 30000 / 1001, 25, 60),
      fc.double({ min: 0.0001, max: MAX_ZOOM, noNaN: true }),
      fc.integer({ min: 1, max: 9e15 }),
      (fps, pixelsPerFrame, extent) => {
        const step = timelineRulerStep(fps, pixelsPerFrame, extent);
        expect(step).toBeGreaterThan(0);
        expect(step * fps * pixelsPerFrame).toBeGreaterThanOrEqual(LABEL_GAP_PX);
        expect(labelCount(fps, extent, step)).toBeLessThanOrEqual(MAX_LABELS);
      },
    ));
  });
});
