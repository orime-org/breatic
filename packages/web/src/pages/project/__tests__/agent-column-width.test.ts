// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import {
  AGENT_COLUMN_MAX_WIDTH,
  AGENT_COLUMN_MIN_WIDTH,
  PAGE_MIN_WIDTH,
  RESIZE_HANDLE_WIDTH,
  SPACE_MIN_WIDTH,
  resolveWidth,
  shouldRestore,
} from '@web/pages/project/agent-column-width';

/** The panel row at the page floor: the whole floor minus the handle. */
const PANELS_AT_FLOOR = PAGE_MIN_WIDTH - RESIZE_HANDLE_WIDTH;

describe('agent column width constants', () => {
  it('page floor is the two minimums plus the handle between them', () => {
    expect(PAGE_MIN_WIDTH).toBe(741);
    expect(PAGE_MIN_WIDTH).toBe(AGENT_COLUMN_MIN_WIDTH + RESIZE_HANDLE_WIDTH + SPACE_MIN_WIDTH);
  });

  it('the four sizes are the numbers the design pinned', () => {
    expect(AGENT_COLUMN_MIN_WIDTH).toBe(320);
    expect(AGENT_COLUMN_MAX_WIDTH).toBe(640);
    expect(SPACE_MIN_WIDTH).toBe(420);
    expect(RESIZE_HANDLE_WIDTH).toBe(1);
  });
});

describe('resolveWidth', () => {
  it('renders the set width when the row is wide enough for it', () => {
    expect(resolveWidth(500, 1400)).toBe(500);
  });

  it('caps the set width at the maximum', () => {
    expect(resolveWidth(900, 1400)).toBe(AGENT_COLUMN_MAX_WIDTH);
  });

  it('raises the set width to the minimum', () => {
    expect(resolveWidth(100, 1400)).toBe(AGENT_COLUMN_MIN_WIDTH);
  });

  it('squeezes the column so the space region keeps its 420', () => {
    // 900 wide row, space wants 420, so the column can only have 480.
    expect(resolveWidth(640, 900)).toBe(480);
  });

  it('stops squeezing at the minimum', () => {
    expect(resolveWidth(640, PANELS_AT_FLOOR)).toBe(AGENT_COLUMN_MIN_WIDTH);
  });

  it('leaves the space region exactly its 420 at the page floor', () => {
    expect(PANELS_AT_FLOOR - resolveWidth(640, PANELS_AT_FLOOR)).toBe(SPACE_MIN_WIDTH);
  });

  it('falls back to the minimum when nothing has been set', () => {
    expect(resolveWidth(null, 1400)).toBe(AGENT_COLUMN_MIN_WIDTH);
  });


  it('stays inside the range and leaves the space region its 420, for every row width', () => {
    for (let panels = PANELS_AT_FLOOR; panels <= 3000; panels += 7) {
      for (const set of [null, 320, 500, 640, 100, 5000]) {
        const width = resolveWidth(set, panels);
        expect(width).toBeGreaterThanOrEqual(AGENT_COLUMN_MIN_WIDTH);
        expect(width).toBeLessThanOrEqual(AGENT_COLUMN_MAX_WIDTH);
        expect(panels - width).toBeGreaterThanOrEqual(SPACE_MIN_WIDTH);
      }
    }
  });
});

describe('shouldRestore', () => {
  it('is false when the rendered width already is the target', () => {
    expect(shouldRestore(500, 500)).toBe(false);
  });

  it('is false inside the one-pixel tolerance, in both directions', () => {
    expect(shouldRestore(500.5, 500)).toBe(false);
    expect(shouldRestore(499.5, 500)).toBe(false);
    expect(shouldRestore(501, 500)).toBe(false);
    expect(shouldRestore(499, 500)).toBe(false);
  });

  it('is true beyond the tolerance, in both directions', () => {
    expect(shouldRestore(502, 500)).toBe(true);
    expect(shouldRestore(498, 500)).toBe(true);
  });
});
