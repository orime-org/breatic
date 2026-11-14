// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The preview frame's size (breatic#1502 design §6.2). The API this file pins, in
 * `@web/spaces/timeline/timeline-preview-fit`:
 * - `timelinePreviewFit(area, frame)` takes the measured area the preview frame is placed in (its 1px border on each
 *   side included) and the document frame size in canvas pixels, and returns `{ factor, width, height }`: `factor` is
 *   display pixels per canvas pixel, `min((area.width - 2) / frame.width, (area.height - 2) / frame.height)`, and
 *   `width` and `height` are the area inside the border that the frame fills, `frame.width * factor` and
 *   `frame.height * factor`. The preview's layers and the layer handles use this same `factor`.
 * - An area with no room inside the border, or an empty frame, gives `{ factor: 0, width: 0, height: 0 }`.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { timelinePreviewFit } from '@web/spaces/timeline/timeline-preview-fit';

// The seven frame presets (breatic#1502 design §2), written out so the expectation is not read from the code under test.
const FRAMES = [[1920, 1080], [1080, 1920], [1080, 1080], [1440, 1080], [1080, 1350], [1080, 1620], [2520, 1080]] as const;

describe('timelinePreviewFit', () => {
  it.each([
    ['16:9 in a 16:9 area', { width: 962, height: 542 }, { width: 1920, height: 1080 }, 0.5, 960, 540],
    ['9:16 held by the area height', { width: 962, height: 542 }, { width: 1080, height: 1920 }, 0.28125, 303.75, 540],
    ['21:9 held by the area width', { width: 962, height: 1002 }, { width: 2520, height: 1080 }, 960 / 2520, 960, 1080 * 960 / 2520],
    ['1:1 held by the area width', { width: 542, height: 802 }, { width: 1080, height: 1080 }, 0.5, 540, 540],
    ['4:5 held by the area height', { width: 1002, height: 677 }, { width: 1080, height: 1350 }, 0.5, 540, 675],
  ])('contains %s inside the 1px border', (_name, area, frame, factor, width, height) => {
    const fit = timelinePreviewFit(area, frame);
    expect(fit.factor).toBeCloseTo(factor, 10);
    expect(fit.width).toBeCloseTo(width, 8);
    expect(fit.height).toBeCloseTo(height, 8);
  });

  it.each([
    ['an area no wider than its border', { width: 2, height: 542 }, { width: 1920, height: 1080 }],
    ['an area no taller than its border', { width: 962, height: 1 }, { width: 1920, height: 1080 }],
    ['an unmeasured area', { width: 0, height: 0 }, { width: 1920, height: 1080 }],
    ['an empty frame', { width: 962, height: 542 }, { width: 0, height: 0 }],
  ])('gives no size for %s', (_name, area, frame) => {
    expect(timelinePreviewFit(area, frame)).toEqual({ factor: 0, width: 0, height: 0 });
  });

  it('fills the area inside the border along one side, never overflows the other, and keeps the frame ratio (fast-check)', () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 4000 }), fc.integer({ min: 3, max: 4000 }), fc.constantFrom(...FRAMES), (areaWidth, areaHeight, [frameWidth, frameHeight]) => {
      const fit = timelinePreviewFit({ width: areaWidth, height: areaHeight }, { width: frameWidth, height: frameHeight });
      const innerWidth = areaWidth - 2;
      const innerHeight = areaHeight - 2;
      expect(fit.factor).toBeCloseTo(Math.min(innerWidth / frameWidth, innerHeight / frameHeight), 12);
      expect(fit.width).toBeLessThanOrEqual(innerWidth + 1e-9);
      expect(fit.height).toBeLessThanOrEqual(innerHeight + 1e-9);
      expect(Math.abs(fit.width - innerWidth) < 1e-9 || Math.abs(fit.height - innerHeight) < 1e-9).toBe(true);
      expect(fit.width).toBeCloseTo(frameWidth * fit.factor, 9);
      expect(fit.height).toBeCloseTo(frameHeight * fit.factor, 9);
    }), { numRuns: 300 });
  });
});
