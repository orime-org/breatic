// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
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
    // Real-world repro (found 2026-07-04, pre-existing): SpaceDrawer's
    // "view" action runs `onView(id)` (ProjectPage claims the slot for
    // the read-only sheet) and then `setOpen(false)` (the drawer
    // releases) inside ONE event handler. The drawer's release check
    // compared against the render-closure `activeOverlayId` — still the
    // drawer's own id — so it nulled the slot the read-only sheet had
    // just claimed, and BOTH overlays ended up closed.
    const drawer = renderHook(() => useExclusiveOverlay('space-drawer'));
    const peek = renderHook(() => useExclusiveOverlay('space-readonly-sheet'));
    act(() => drawer.result.current[1](true));
    expect(drawer.result.current[0]).toBe(true);
    // one handler, no re-render in between: claim for peek, release drawer
    act(() => {
      peek.result.current[1](true);
      drawer.result.current[1](false);
    });
    expect(peek.result.current[0]).toBe(true);
    expect(drawer.result.current[0]).toBe(false);
  });
});
