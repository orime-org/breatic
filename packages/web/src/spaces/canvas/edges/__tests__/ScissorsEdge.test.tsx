// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  edgeOverlayScale,
  shouldShowScissors,
} from '@web/spaces/canvas/edges/ScissorsEdge';

describe('edgeOverlayScale (constant screen size = 1 / zoom)', () => {
  it('counter-scales the overlay against the canvas zoom', () => {
    // Zoomed in 2× → the overlay scales 0.5× so it stays the same screen size.
    expect(edgeOverlayScale(2)).toBe(0.5);
    // Zoomed out to 0.5× → the overlay scales 2× to keep its screen size.
    expect(edgeOverlayScale(0.5)).toBe(2);
    // 100% zoom is identity.
    expect(edgeOverlayScale(1)).toBe(1);
  });

  it('falls back to 1 for a non-positive zoom (never divides by zero)', () => {
    expect(edgeOverlayScale(0)).toBe(1);
    expect(edgeOverlayScale(-1)).toBe(1);
  });
});

describe('shouldShowScissors (selected and not a read-only viewer)', () => {
  it('shows only when the edge is selected and the canvas is editable', () => {
    expect(shouldShowScissors(true, false)).toBe(true);
  });

  it('hides when the edge is not selected', () => {
    expect(shouldShowScissors(false, false)).toBe(false);
  });

  it('hides for a read-only viewer even when selected', () => {
    expect(shouldShowScissors(true, true)).toBe(false);
  });
});
