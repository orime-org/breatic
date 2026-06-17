// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { shouldShowScissors } from '@web/spaces/canvas/edges/ScissorsEdge';

// The scissors button's counter-scale (constant screen size down to a floor
// zoom) is the shared `overlayCounterScale` — covered by overlay-scale.test.ts.

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
