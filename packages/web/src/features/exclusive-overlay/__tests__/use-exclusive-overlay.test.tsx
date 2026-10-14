// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useUIStore } from '@web/stores/ui';

beforeEach(() => {
  useUIStore.setState({ activeOverlayId: null });
});

describe('useExclusiveOverlay', () => {
  it('claiming the slot closes the previously active overlay', () => {
    const a = renderHook(() => useExclusiveOverlay('overlay-a'));
    const b = renderHook(() => useExclusiveOverlay('overlay-b'));
    act(() => a.result.current[1](true));
    expect(a.result.current[0]).toBe(true);
    act(() => b.result.current[1](true));
    expect(a.result.current[0]).toBe(false);
    expect(b.result.current[0]).toBe(true);
  });

  it('handoff race: closing A inside the same handler that opened B must not release B', () => {
    // One overlay's action opens another and closes itself inside ONE event
    // handler. A release check that compared against the render-closure
    // `activeOverlayId` - still the closing overlay's own id - would null the
    // slot the other one had just claimed, and BOTH overlays would end up
    // closed.
    const drawer = renderHook(() => useExclusiveOverlay('space-drawer'));
    const activity = renderHook(() => useExclusiveOverlay('project-activity'));
    act(() => drawer.result.current[1](true));
    expect(drawer.result.current[0]).toBe(true);
    // one handler, no re-render in between: claim for activity, release drawer
    act(() => {
      activity.result.current[1](true);
      drawer.result.current[1](false);
    });
    expect(activity.result.current[0]).toBe(true);
    expect(drawer.result.current[0]).toBe(false);
  });
});
