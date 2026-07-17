// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Crop-math tests (#1782 focus tool): marquee draw, move, 8-handle resize,
 * ratio presets, and the display→natural pixel mapping. All geometry is
 * pure — the overlay component only feeds pointer coordinates in.
 */

import { describe, it, expect } from 'vitest';

import {
  CROP_RATIOS,
  MIN_CROP_PX,
  captureResize,
  isNaturalCropValid,
  resizeFromCapture,
  drawRect,
  moveRect,
  resizeRect,
  applyRatioPreset,
  toNaturalCrop,
  isCropValid,
} from '@web/spaces/canvas/focus/crop-math';

const BOUNDS = { width: 400, height: 300 };

describe('drawRect — marquee from an anchor to the cursor', () => {
  it('normalizes any drag direction into a positive rect', () => {
    // Down-right and up-left drags describe the same rect.
    const a = drawRect({ x: 50, y: 40 }, { x: 150, y: 120 }, BOUNDS, null);
    const b = drawRect({ x: 150, y: 120 }, { x: 50, y: 40 }, BOUNDS, null);
    expect(a).toEqual({ x: 50, y: 40, width: 100, height: 80 });
    expect(b).toEqual(a);
  });

  it('clamps the cursor to the image bounds', () => {
    const r = drawRect({ x: 350, y: 250 }, { x: 900, y: 900 }, BOUNDS, null);
    expect(r).toEqual({ x: 350, y: 250, width: 50, height: 50 });
  });

  it('with a ratio, follows the dominant axis and keeps w/h exact', () => {
    // ratio 2 (w:h = 2:1); a mostly-horizontal drag drives width.
    const r = drawRect({ x: 0, y: 0 }, { x: 200, y: 10 }, BOUNDS, 2);
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
    // A mostly-vertical drag drives height.
    const r2 = drawRect({ x: 0, y: 0 }, { x: 10, y: 100 }, BOUNDS, 2);
    expect(r2.height).toBe(100);
    expect(r2.width).toBe(200);
  });

  it('with a ratio, shrinks to fit the bounds while keeping the ratio', () => {
    // Anchor near the right edge: only 50px of x-room, so the ratio-2 rect
    // caps at 50×25 no matter how far the cursor goes.
    const r = drawRect({ x: 350, y: 0 }, { x: 900, y: 300 }, BOUNDS, 2);
    expect(r.width).toBe(50);
    expect(r.height).toBe(25);
    expect(r.x).toBe(350);
  });

  it('with a ratio, an up-left drag grows the rect toward the anchor origin', () => {
    const r = drawRect({ x: 200, y: 200 }, { x: 100, y: 100 }, BOUNDS, 1);
    expect(r).toEqual({ x: 100, y: 100, width: 100, height: 100 });
  });
});

describe('moveRect — clamped translation', () => {
  it('moves within bounds and clamps at the edges', () => {
    const rect = { x: 10, y: 10, width: 100, height: 100 };
    expect(moveRect(rect, 20, 30, BOUNDS)).toEqual({
      x: 30,
      y: 40,
      width: 100,
      height: 100,
    });
    expect(moveRect(rect, -50, -50, BOUNDS)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(moveRect(rect, 1000, 1000, BOUNDS)).toEqual({
      x: 300,
      y: 200,
      width: 100,
      height: 100,
    });
  });
});

describe('resizeRect — 8-handle resize anchored at the opposite side', () => {
  const rect = { x: 100, y: 100, width: 100, height: 100 };

  it('corner se: follows the cursor, anchored at the nw corner', () => {
    const r = resizeRect(rect, 'se', { x: 250, y: 180 }, BOUNDS, null);
    expect(r).toEqual({ x: 100, y: 100, width: 150, height: 80 });
  });

  it('corner nw: crossing the anchor flips the rect (normalized)', () => {
    const r = resizeRect(rect, 'nw', { x: 220, y: 220 }, BOUNDS, null);
    expect(r).toEqual({ x: 200, y: 200, width: 20, height: 20 });
  });

  it('edge e: changes width only', () => {
    const r = resizeRect(rect, 'e', { x: 260, y: 999 }, BOUNDS, null);
    expect(r).toEqual({ x: 100, y: 100, width: 160, height: 100 });
  });

  it('edge n: changes the top edge only', () => {
    const r = resizeRect(rect, 'n', { x: 0, y: 60 }, BOUNDS, null);
    expect(r).toEqual({ x: 100, y: 60, width: 100, height: 140 });
  });

  it('corner with ratio keeps w/h exact while clamped to bounds', () => {
    const r = resizeRect(rect, 'se', { x: 900, y: 900 }, BOUNDS, 2);
    // nw anchor at (100,100): x-room 300, y-room 200 → ratio-2 caps at 300×150.
    expect(r).toEqual({ x: 100, y: 100, width: 300, height: 150 });
  });

  it('edge e with ratio derives height around the vertical centre', () => {
    const r = resizeRect(rect, 'e', { x: 300, y: 0 }, BOUNDS, 2);
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
    // Vertical centre preserved (was 150).
    expect(r.y + r.height / 2).toBe(150);
  });

  // Adversarial 2026-07-16: the ratio branch used to assume no flip and
  // recompute the position on the anchor's original side — dragging an edge
  // handle PAST its anchor with a ratio active jumped the rect to the wrong
  // side of the anchor (free-form flipped correctly; corners were immune).
  it('edge e with ratio crossing the anchor flips to the cursor side', () => {
    // 'e' anchors at the LEFT edge (x=100); cursor at x=40 is left of it.
    const r = resizeRect(rect, 'e', { x: 40, y: 150 }, BOUNDS, 2);
    expect(r.x + r.width).toBe(100); // grows leftward from the anchor
    expect(r.width).toBe(60);
    expect(r.height).toBe(30);
  });

  it('edge w with ratio crossing the anchor flips to the cursor side', () => {
    // 'w' anchors at the RIGHT edge (x=200); cursor at x=260 is right of it.
    const r = resizeRect(rect, 'w', { x: 260, y: 150 }, BOUNDS, 2);
    expect(r.x).toBe(200);
    expect(r.width).toBe(60);
  });

  it('edge s with ratio crossing the anchor flips upward from the top anchor', () => {
    // 's' anchors at the TOP edge (y=100); cursor at y=40 is above it.
    const r = resizeRect(rect, 's', { x: 150, y: 40 }, BOUNDS, 1);
    expect(r.y + r.height).toBe(100);
    expect(r.height).toBe(60);
    expect(r.width).toBe(60);
  });

  it('edge n with ratio crossing the anchor flips downward from the bottom anchor', () => {
    // 'n' anchors at the BOTTOM edge (y=200); cursor at y=260 is below it.
    const r = resizeRect(rect, 'n', { x: 150, y: 260 }, BOUNDS, 1);
    expect(r.y).toBe(200);
    expect(r.height).toBe(60);
  });

  it('edge handle with ratio caps by the room toward the drag direction', () => {
    // 'e' anchored at x=100 dragged far right: x-room 300, ratio 2 needs
    // height 150 (fits 300-bounds) → capped at 300×150 exactly at bounds.
    const r = resizeRect(rect, 'e', { x: 900, y: 150 }, BOUNDS, 2);
    expect(r.width).toBe(300);
    expect(r.height).toBe(150);
    expect(r.x).toBe(100);
  });
});

describe('captureResize / resizeFromCapture — frozen anchor across a gesture (round-9)', () => {
  it('a sequential se-drag crossing the anchor keeps the fixed corner at its original position', () => {
    // Old per-move re-derivation collapsed this into a cursor-chasing
    // sliver: moves 140→…→60 ended {x:80,w:20} instead of {x:60,w:40}.
    const start = { x: 100, y: 100, width: 50, height: 50 };
    const capture = captureResize(start, 'se');
    let r = start;
    for (const x of [140, 120, 101, 99, 95, 80, 60]) {
      r = resizeFromCapture(capture, { x, y: 140 }, BOUNDS, null);
    }
    // Fixed nw corner stays at (100,100); crossing flipped to its left.
    expect(r).toEqual({ x: 60, y: 100, width: 40, height: 40 });
  });

  it('a sequential e-edge drag crossing the anchor keeps the fixed left edge', () => {
    const start = { x: 100, y: 100, width: 50, height: 50 };
    const capture = captureResize(start, 'e');
    let r = start;
    for (const x of [120, 99, 90, 70]) {
      r = resizeFromCapture(capture, { x, y: 0 }, BOUNDS, null);
    }
    expect(r).toEqual({ x: 70, y: 100, width: 30, height: 50 });
  });

  it('edge capture with a ratio keeps the frozen cross-axis centre', () => {
    const start = { x: 100, y: 100, width: 50, height: 50 };
    const capture = captureResize(start, 'e');
    const r = resizeFromCapture(capture, { x: 300, y: 999 }, BOUNDS, 2);
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
    expect(r.y + r.height / 2).toBe(125); // centre of the FROZEN extents
  });
});

describe('applyRatioPreset — re-shape an existing rect', () => {
  it('keeps the width and centre, derives the height', () => {
    const r = applyRatioPreset(
      { x: 100, y: 100, width: 100, height: 100 },
      2,
      BOUNDS,
    );
    expect(r.width).toBe(100);
    expect(r.height).toBe(50);
    // Centre preserved.
    expect(r.x + r.width / 2).toBe(150);
    expect(r.y + r.height / 2).toBe(150);
  });

  it('shrinks proportionally when the derived height overflows the bounds', () => {
    // ratio 0.5 (portrait 1:2) on a wide rect near the bottom: height would
    // overflow, so the rect shrinks keeping the ratio and stays in bounds.
    const r = applyRatioPreset(
      { x: 0, y: 200, width: 300, height: 80 },
      0.5,
      BOUNDS,
    );
    expect(r.width / r.height).toBeCloseTo(0.5, 5);
    expect(r.y + r.height).toBeLessThanOrEqual(BOUNDS.height);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
});

describe('applyRatioPreset — minimum seeding (round-4)', () => {
  it('grows a thin rect so BOTH dims meet MIN_CROP_PX at the preset ratio', () => {
    // 10px wide + 16:9 used to derive a ~5.6px height — a persistent
    // sub-minimum sliver the degenerate-rect invariant forbids.
    const r = applyRatioPreset(
      { x: 100, y: 100, width: 10, height: 10 },
      16 / 9,
      BOUNDS,
    );
    expect(isCropValid(r)).toBe(true);
    expect(r.width / r.height).toBeCloseTo(16 / 9, 5);
  });
});

describe('toNaturalCrop — display px → source-resolution px', () => {
  it('scales by the display/natural ratio and rounds to integers', () => {
    // Display 400×300, natural 1600×1200 → scale ×4.
    const c = toNaturalCrop(
      { x: 50, y: 25, width: 100, height: 75 },
      { width: 400, height: 300 },
      { width: 1600, height: 1200 },
    );
    expect(c).toEqual({ x: 200, y: 100, width: 400, height: 300 });
  });

  it('never exceeds the natural bounds after rounding', () => {
    const c = toNaturalCrop(
      { x: 399.4, y: 299.4, width: 0.6, height: 0.6 },
      { width: 400, height: 300 },
      { width: 401, height: 301 },
    );
    expect(c.x + c.width).toBeLessThanOrEqual(401);
    expect(c.y + c.height).toBeLessThanOrEqual(301);
    expect(c.width).toBeGreaterThanOrEqual(1);
    expect(c.height).toBeGreaterThanOrEqual(1);
  });
});

describe('isNaturalCropValid — zoom-independent confirm gauge (round-8)', () => {
  it('a tiny display rect selecting a large natural region stays valid', () => {
    // Zoomed way out: 4×4 display px over a 4000×3000 natural image at a
    // 40×30 display box = 400×400 natural px — clearly confirmable.
    expect(
      isNaturalCropValid(
        { x: 0, y: 0, width: 4, height: 4 },
        { width: 40, height: 30 },
        { width: 4000, height: 3000 },
      ),
    ).toBe(true);
  });

  it('a large display rect selecting almost no natural pixels is invalid', () => {
    // Zoomed way in: 100×100 display px over a 20×20 natural image at a
    // 400×400 display box = 5×5 natural px < the natural minimum.
    expect(
      isNaturalCropValid(
        { x: 0, y: 0, width: 100, height: 100 },
        { width: 400, height: 400 },
        { width: 20, height: 20 },
      ),
    ).toBe(false);
  });
});

describe('validity + presets', () => {
  it('isCropValid requires both dims at the minimum', () => {
    expect(isCropValid({ x: 0, y: 0, width: MIN_CROP_PX, height: MIN_CROP_PX })).toBe(true);
    expect(isCropValid({ x: 0, y: 0, width: MIN_CROP_PX - 1, height: 50 })).toBe(false);
  });

  it('ships the seven ratified presets in order', () => {
    expect(CROP_RATIOS.map((r) => r.key)).toEqual([
      '16:9',
      '3:2',
      '4:3',
      '1:1',
      '3:4',
      '2:3',
      '9:16',
    ]);
    const oneToOne = CROP_RATIOS.find((r) => r.key === '1:1');
    expect(oneToOne?.value).toBe(1);
  });
});
