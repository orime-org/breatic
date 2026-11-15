// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import { userMovedScroll } from '@web/spaces/timeline/timeline-follow-scroll';

describe('userMovedScroll', () => {
  const max = { left: 1000, top: 200 };

  it('is false when nothing moved', () => {
    expect(userMovedScroll({ left: 300, top: 10 }, { left: 300, top: 10 }, max)).toBe(false);
  });

  it('is true when the user scrolls either axis', () => {
    expect(userMovedScroll({ left: 300, top: 10 }, { left: 340, top: 10 }, max)).toBe(true);
    expect(userMovedScroll({ left: 300, top: 10 }, { left: 300, top: 40 }, max)).toBe(true);
  });

  it('is true when the user scrolls to the very end', () => {
    expect(userMovedScroll({ left: 300, top: 10 }, { left: 1000, top: 10 }, max)).toBe(true);
  });

  it('is false when a shorter track clamps the position to its new end', () => {
    expect(userMovedScroll({ left: 1400, top: 10 }, { left: 1000, top: 10 }, max)).toBe(false);
  });

  it('is false when a removed track clamps the vertical position', () => {
    expect(userMovedScroll({ left: 300, top: 260 }, { left: 300, top: 200 }, max)).toBe(false);
  });

  it('is true when one axis is clamped and the other is scrolled by the user', () => {
    expect(userMovedScroll({ left: 1400, top: 10 }, { left: 1000, top: 60 }, max)).toBe(true);
  });

  it('allows sub-pixel noise', () => {
    expect(userMovedScroll({ left: 300, top: 10 }, { left: 300.5, top: 10 }, max)).toBe(false);
  });
});
