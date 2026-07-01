// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { FIT_VIEW_OPTIONS } from '@web/spaces/canvas/viewport-config';

// Regression guard for #1547: opening a space (auto fitView) and the toolbar
// "fit to window" button share this clamp so neither zooms past 100% for
// sparse content nor below 10% for spread-out content. The real behavioural
// proof is the browser smoke (fitView needs real layout, which jsdom lacks) —
// this test only pins the clamp values so a later edit can't silently drop them.
describe('FIT_VIEW_OPTIONS (open / fit-to-window zoom clamp, #1547)', () => {
  it('caps fit zoom at 100% (1x) so opening a sparse space never zooms in past 1x', () => {
    expect(FIT_VIEW_OPTIONS.maxZoom).toBe(1);
  });

  it('floors fit zoom at 10% (0.1), matching the canvas global minZoom', () => {
    expect(FIT_VIEW_OPTIONS.minZoom).toBe(0.1);
  });
});
