// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  edgeLanding,
  endsAfter,
  scrollTargetFor,
  startsBefore,
} from '@web/pages/project/chrome/tab-bar/tab-scroll';

const VISIBLE = { start: 0, end: 100 };

describe('startsBefore', () => {
  it('is true when the tab reaches past the leading edge', () => {
    expect(startsBefore({ start: -20 }, VISIBLE)).toBe(true);
  });

  it('is false when the tab begins inside the strip', () => {
    expect(startsBefore({ start: 10 }, VISIBLE)).toBe(false);
  });

  it('absorbs a sub-pixel overhang', () => {
    expect(startsBefore({ start: -0.5 }, VISIBLE)).toBe(false);
  });
});

describe('endsAfter', () => {
  it('is true when the tab reaches past the trailing edge', () => {
    expect(endsAfter({ end: 140 }, VISIBLE)).toBe(true);
  });

  it('is false when the tab ends inside the strip', () => {
    expect(endsAfter({ end: 90 }, VISIBLE)).toBe(false);
  });

  it('absorbs a sub-pixel overhang', () => {
    expect(endsAfter({ end: 100.5 }, VISIBLE)).toBe(false);
  });
});

describe('edgeLanding', () => {
  it('puts the tab against the leading edge', () => {
    expect(edgeLanding({ start: 250, end: 310 }, VISIBLE, 'start')).toBe(250);
  });

  it('puts the tab against the trailing edge', () => {
    expect(edgeLanding({ start: 250, end: 310 }, VISIBLE, 'end')).toBe(210);
  });

  it('reads the strip width off the visible span', () => {
    expect(edgeLanding({ start: 0, end: 60 }, { start: 40, end: 80 }, 'end'))
      .toBe(20);
  });
});

describe('scrollTargetFor', () => {
  it('has nothing to do for a tab already whole on screen', () => {
    expect(scrollTargetFor({ start: 10, end: 60 }, VISIBLE)).toBeNull();
  });

  it('brings a tab cut off at the trailing edge flush right', () => {
    expect(scrollTargetFor({ start: 80, end: 140 }, VISIBLE)).toBe(40);
  });

  it('brings a tab cut off at the leading edge flush left', () => {
    expect(scrollTargetFor({ start: -30, end: 20 }, VISIBLE)).toBe(-30);
  });

  it('brings a tab wider than the strip flush left', () => {
    // Both edges are off, and no scroll position holds such a tab whole.
    expect(scrollTargetFor({ start: 60, end: 220 }, { start: 0, end: 137 }))
      .toBe(60);
  });

  it('has nothing to do once a tab wider than the strip starts at the edge', () => {
    // The measured swing: 137px of strip, a 160px tab. Reporting this as
    // unfinished left the reveal control clicking between two positions
    // forever, because no position satisfies "whole on screen".
    expect(scrollTargetFor({ start: 0, end: 160 }, { start: 0, end: 137 }))
      .toBeNull();
  });

  it('still has work when a tab wider than the strip sits past the edge', () => {
    expect(scrollTargetFor({ start: 200, end: 360 }, { start: 100, end: 237 }))
      .toBe(200);
  });

  it('absorbs a sub-pixel gap at the edge', () => {
    expect(scrollTargetFor({ start: 0.5, end: 160 }, { start: 0, end: 137 }))
      .toBeNull();
  });

  it('lands where a further call has nothing left to do', () => {
    // The question the reveal control is enabled by and the move it performs
    // are the same function, so one click always settles it.
    const span = { start: 80, end: 140 };
    const target = scrollTargetFor(span, VISIBLE);
    expect(target).not.toBeNull();
    const settled = { start: target!, end: target! + 100 };
    expect(scrollTargetFor(span, settled)).toBeNull();
  });

  it('settles a tab wider than the strip in one call too', () => {
    const span = { start: 60, end: 220 };
    const visible = { start: 0, end: 137 };
    const target = scrollTargetFor(span, visible);
    expect(target).not.toBeNull();
    const settled = { start: target!, end: target! + 137 };
    expect(scrollTargetFor(span, settled)).toBeNull();
  });
});
