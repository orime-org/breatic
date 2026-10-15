// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the camera goes once a proposal has landed (inner#1443): centred on
 * what was placed, at the reader's zoom while it fits, zoomed out just enough
 * when it does not.
 */

import { describe, it, expect } from 'vitest';

import { CANVAS_MIN_ZOOM } from '@web/lib/canvas-zoom';
import { frameProposal } from '@web/spaces/canvas/lib/place-flow';

const pane = { width: 1200, height: 800 };

/**
 * The flow point at the middle of the pane under a viewport.
 * @param v - The viewport.
 * @returns The point.
 */
const middle = (v: { x: number; y: number; zoom: number }): { x: number; y: number } => ({
  x: (pane.width / 2 - v.x) / v.zoom,
  y: (pane.height / 2 - v.y) / v.zoom,
});

describe('frameProposal', () => {
  it('keeps the reader zoom and centres on the batch when it fits', () => {
    const bounds = { x: 2000, y: -300, width: 288, height: 192 };
    const v = frameProposal(bounds, pane, 0.8);
    expect(v.zoom).toBe(0.8);
    expect(middle(v).x).toBeCloseTo(2144);
    expect(middle(v).y).toBeCloseTo(-204);
  });

  it('zooms out just enough to show a batch that does not fit, centred', () => {
    const bounds = { x: 0, y: 0, width: 3000, height: 400 };
    const v = frameProposal(bounds, pane, 1);
    expect(v.zoom).toBeLessThan(1);
    expect(v.zoom * bounds.width).toBeLessThanOrEqual(pane.width);
    expect(v.zoom * bounds.width).toBeGreaterThan(pane.width * 0.8);
    expect(middle(v).x).toBeCloseTo(1500);
    expect(middle(v).y).toBeCloseTo(200);
  });

  it('never zooms in past where the reader was', () => {
    const v = frameProposal({ x: 0, y: 0, width: 100, height: 100 }, pane, 0.3);
    expect(v.zoom).toBe(0.3);
  });

  it('stops at the canvas floor for a batch too large to fit even there', () => {
    const v = frameProposal({ x: 0, y: 0, width: 100_000, height: 400 }, pane, 1);
    expect(v.zoom).toBe(CANVAS_MIN_ZOOM);
    expect(middle(v).x).toBeCloseTo(50_000);
  });
});
