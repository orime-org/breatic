// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  OVERLAY_SCALE_FLOOR_ZOOM,
  countsColumnOffset,
  overlayCounterScale,
} from '@web/spaces/canvas/overlay-scale';

describe('overlayCounterScale (constant screen size down to a floor zoom)', () => {
  it('counter-scales 1/zoom at or above the floor (constant screen size)', () => {
    // Zoomed in 2× → overlay scales 0.5× so it keeps the same screen size.
    expect(overlayCounterScale(2)).toBe(0.5);
    // 100% zoom is identity.
    expect(overlayCounterScale(1)).toBe(1);
    // Exactly at the floor (0.5) → 1/0.5 = 2 (still constant screen size here).
    expect(overlayCounterScale(0.5)).toBe(2);
  });

  it('caps the scale below the floor so overlays shrink with the canvas', () => {
    // Below the floor the scale stops growing (stays 1/floor = 2) instead of
    // 1/zoom, so the overlay's screen size = base * 2 * zoom now shrinks as the
    // canvas zooms further out (icon + name + scissors follow the canvas).
    expect(overlayCounterScale(0.25)).toBe(2);
    expect(overlayCounterScale(0.1)).toBe(2);
  });

  it('is continuous at the floor — no size jump across the threshold', () => {
    // Just above the floor follows 1/zoom; at and below the floor it is 1/floor.
    // Both meet at exactly 2 when zoom = floor, so there is no discontinuity.
    expect(overlayCounterScale(0.5)).toBe(2);
    expect(overlayCounterScale(0.49)).toBe(2);
    expect(overlayCounterScale(0.51)).toBeCloseTo(1 / 0.51, 10);
  });

  it('falls back to 1 for a non-positive zoom (never divides by zero)', () => {
    expect(overlayCounterScale(0)).toBe(1);
    expect(overlayCounterScale(-1)).toBe(1);
  });

  it('respects a custom floor zoom', () => {
    expect(overlayCounterScale(0.2, 0.4)).toBeCloseTo(2.5, 10); // 1 / 0.4
    expect(overlayCounterScale(1, 0.4)).toBe(1);
  });

  it('exposes the default floor as 50% zoom', () => {
    expect(OVERLAY_SCALE_FLOOR_ZOOM).toBe(0.5);
  });
});

describe('countsColumnOffset', () => {
  // The column holds a constant 44 screen px, and the gap between it and the
  // node holds a constant 8 — both counter-scale together, so the offset that
  // clears them is one number at every zoom above the floor.
  it('clears the column at 100% zoom', () => {
    expect(countsColumnOffset(1)).toBe(60);
  });

  // The gap used to be measured in flow units while the box was measured in
  // screen pixels, so zooming in pulled the column away from the node it
  // belongs to (user 2026-09-06).
  it('holds the same clearance however far the canvas zooms in', () => {
    expect(countsColumnOffset(2)).toBe(60);
    expect(countsColumnOffset(8)).toBe(60);
  });

  // Below the counter-scale floor the box shrinks with the canvas, so the
  // offset follows it down rather than holding a gap wider than the node.
  it('follows the column down below the counter-scale floor', () => {
    expect(countsColumnOffset(0.25)).toBeLessThan(countsColumnOffset(1));
  });
});
