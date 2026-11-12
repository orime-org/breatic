// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_VIEWFINDER_RATIO,
  VIEWFINDER_RATIOS,
  captureSize,
  captureViewOffset,
  largestFrame,
  menuCentre,
  refitFrame,
  resizeFrame,
  viewfinderRatioValue,
  viewfinderSafeArea,
} from '@web/spaces/three-d/viewfinder/viewfinder-geometry';

const SAFE = { x: 40, y: 60, width: 800, height: 400 };
const MIN = 120;

/**
 * Whether a rect lies inside another, allowing float noise.
 * @param inner - The rect that must fit.
 * @param outer - The containing rect.
 * @returns True when inner fits.
 */
function inside(inner: { x: number; y: number; width: number; height: number }, outer: typeof SAFE): boolean {
  const e = 1e-6;
  return inner.x >= outer.x - e && inner.y >= outer.y - e
    && inner.x + inner.width <= outer.x + outer.width + e && inner.y + inner.height <= outer.y + outer.height + e;
}

describe('viewfinder ratios', () => {
  it('offers Free and the seven fixed ratios, defaulting to 16:9', () => {
    expect(VIEWFINDER_RATIOS).toEqual(['Free', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']);
    expect(DEFAULT_VIEWFINDER_RATIO).toBe('16:9');
    expect(viewfinderRatioValue('Free')).toBeNull();
    expect(viewfinderRatioValue('16:9')).toBeCloseTo(16 / 9);
    expect(viewfinderRatioValue('2:3')).toBeCloseTo(2 / 3);
  });
});

describe('the safe area', () => {
  it('insets the viewport on every side; an open right panel moves the right edge to its left edge', () => {
    expect(viewfinderSafeArea({ width: 1000, height: 600 }, { top: 60, right: 40, bottom: 100, left: 40 })).toEqual({ x: 40, y: 60, width: 920, height: 440 });
    expect(viewfinderSafeArea({ width: 1000, height: 600 }, { top: 60, right: 360, bottom: 100, left: 40 })).toEqual({ x: 40, y: 60, width: 600, height: 440 });
  });

  it('never goes negative in a viewport smaller than its insets', () => {
    const safe = viewfinderSafeArea({ width: 50, height: 50 }, { top: 60, right: 40, bottom: 100, left: 40 });
    expect(safe.width).toBe(0);
    expect(safe.height).toBe(0);
  });
});

describe('the default frame', () => {
  it.each(VIEWFINDER_RATIOS.filter((key) => key !== 'Free'))('is the largest centred %s rectangle inside the safe area', (key) => {
    const ratio = viewfinderRatioValue(key) ?? 0;
    const frame = largestFrame(ratio, SAFE);
    expect(frame.width / frame.height).toBeCloseTo(ratio);
    expect(inside(frame, SAFE)).toBe(true);
    expect(frame.width === SAFE.width || Math.abs(frame.height - SAFE.height) < 1e-6).toBe(true);
    expect(frame.x + frame.width / 2).toBeCloseTo(SAFE.x + SAFE.width / 2);
    expect(frame.y + frame.height / 2).toBeCloseTo(SAFE.y + SAFE.height / 2);
  });

  it('is the whole safe area for Free', () => {
    expect(largestFrame(null, SAFE)).toEqual(SAFE);
  });
});

describe('dragging a corner', () => {
  const start = { x: 200, y: 160, width: 320, height: 180 };

  it('keeps a fixed ratio and the opposite corner still', () => {
    const next = resizeFrame(start, 'se', { x: 600, y: 600 }, SAFE, 16 / 9, MIN);
    expect(next.x).toBe(200);
    expect(next.y).toBe(160);
    expect(next.width / next.height).toBeCloseTo(16 / 9);
    expect(inside(next, SAFE)).toBe(true);
  });

  it('changes width and height independently under Free', () => {
    const next = resizeFrame(start, 'nw', { x: 100, y: 100 }, SAFE, null, MIN);
    expect(next).toEqual({ x: 100, y: 100, width: 420, height: 240 });
  });

  it('stops at the minimum edge instead of collapsing or flipping past the anchor', () => {
    const free = resizeFrame(start, 'se', { x: 150, y: 120 }, SAFE, null, MIN);
    expect(free).toEqual({ x: 200, y: 160, width: MIN, height: MIN });
    const fixed = resizeFrame(start, 'se', { x: 201, y: 161 }, SAFE, 16 / 9, MIN);
    expect(fixed.x).toBe(200);
    expect(fixed.y).toBe(160);
    expect(Math.min(fixed.width, fixed.height)).toBeCloseTo(MIN);
    expect(fixed.width / fixed.height).toBeCloseTo(16 / 9);
  });

  it('never leaves the safe area or drops below the minimum, for any corner and cursor', () => {
    fc.assert(fc.property(
      fc.constantFrom<'ne' | 'nw' | 'se' | 'sw'>('ne', 'nw', 'se', 'sw'),
      fc.constantFrom<number | null>(null, 16 / 9, 9 / 16, 1, 4 / 3),
      fc.integer({ min: -500, max: 1500 }), fc.integer({ min: -500, max: 1500 }),
      (corner, ratio, x, y) => {
        const frame = ratio === null ? start : largestFrame(ratio, { x: 200, y: 160, width: 320, height: 180 });
        const next = resizeFrame(frame, corner, { x, y }, SAFE, ratio, MIN);
        expect(inside(next, SAFE)).toBe(true);
        expect(Math.min(next.width, next.height)).toBeGreaterThanOrEqual(MIN * (1 - 1e-9));
        if (ratio !== null) expect(next.width / next.height).toBeCloseTo(ratio);
      },
    ));
  });
});

describe('refitting to a new safe area', () => {
  it('scales a fixed ratio about its relative centre, keeping the ratio', () => {
    const frame = largestFrame(16 / 9, SAFE);
    const narrower = { x: 40, y: 60, width: 500, height: 400 };
    const next = refitFrame(frame, SAFE, narrower, 16 / 9);
    expect(next.width / next.height).toBeCloseTo(16 / 9);
    expect(inside(next, narrower)).toBe(true);
  });

  it('keeps a fixed-ratio frame the same size when only one side of the area grows', () => {
    const frame = { x: 140, y: 110, width: 200, height: 150 };
    const wider = { x: 40, y: 60, width: 1600, height: 400 };
    const next = refitFrame(frame, SAFE, wider, 4 / 3);
    expect(next.width).toBe(200);
    expect(next.height).toBe(150);
    expect(next.x + 100 - wider.x).toBeCloseTo(((frame.x + 100 - SAFE.x) / SAFE.width) * wider.width);
  });

  it('maps a Free frame to the same relative position and shape', () => {
    const narrower = { x: 40, y: 60, width: 600, height: 400 };
    expect(refitFrame(SAFE, SAFE, narrower, null)).toEqual(narrower);
    const frame = { x: 140, y: 110, width: 200, height: 100 };
    const next = refitFrame(frame, SAFE, narrower, null);
    expect(next.width).toBeCloseTo(150);
    expect(next.height).toBeCloseTo(100);
    expect(next.x).toBeCloseTo(40 + 100 * 0.75);
  });

  it('gives back the original frame after the area shrinks and grows back', () => {
    const narrower = { x: 40, y: 60, width: 520, height: 400 };
    for (const ratio of [null, 16 / 9, 1]) {
      const frame = ratio === null ? { x: 100, y: 90, width: 500, height: 250 } : largestFrame(ratio, SAFE);
      const back = refitFrame(refitFrame(frame, SAFE, narrower, ratio), narrower, SAFE, ratio);
      expect(back.x).toBeCloseTo(frame.x);
      expect(back.y).toBeCloseTo(frame.y);
      expect(back.width).toBeCloseTo(frame.width);
      expect(back.height).toBeCloseTo(frame.height);
    }
  });

  it('always lands inside the new area', () => {
    fc.assert(fc.property(fc.integer({ min: 200, max: 2000 }), fc.integer({ min: 150, max: 1200 }), fc.constantFrom<number | null>(null, 4 / 3, 9 / 16),
      (width, height, ratio) => {
        const to = { x: 40, y: 60, width, height };
        expect(inside(refitFrame(largestFrame(ratio ?? 4 / 3, SAFE), SAFE, to, ratio), to)).toBe(true);
      }));
  });
});

describe('the menu under the frame', () => {
  it('centres under the frame', () => {
    expect(menuCentre({ x: 300, y: 0, width: 200, height: 100 }, 300, 1000, 20)).toBe(400);
  });

  it('stays inside the Space when the frame sits near a side', () => {
    expect(menuCentre({ x: 20, y: 0, width: 120, height: 120 }, 420, 1000, 20)).toBe(230);
    expect(menuCentre({ x: 860, y: 0, width: 120, height: 120 }, 420, 1000, 20)).toBe(770);
  });

  it('centres in the Space when the menu is wider than it', () => {
    expect(menuCentre({ x: 20, y: 0, width: 120, height: 120 }, 900, 600, 20)).toBe(300);
  });
});

describe('the captured image size', () => {
  it('has a 2048 long edge and the frame aspect, rounded', () => {
    expect(captureSize({ x: 0, y: 0, width: 320, height: 180 }, 2048)).toEqual({ width: 2048, height: 1152 });
    expect(captureSize({ x: 0, y: 0, width: 180, height: 320 }, 2048)).toEqual({ width: 1152, height: 2048 });
    expect(captureSize({ x: 0, y: 0, width: 333, height: 217 }, 2048)).toEqual({ width: 2048, height: 1335 });
  });

  it('maps the frame to a camera view offset at the output scale', () => {
    const frame = { x: 100, y: 50, width: 400, height: 225 };
    const size = captureSize(frame, 2048);
    expect(captureViewOffset(frame, { width: 1000, height: 600 }, size)).toEqual({
      fullWidth: 5120, fullHeight: 3072, x: 512, y: 256, width: 2048, height: 1152,
    });
  });
});
