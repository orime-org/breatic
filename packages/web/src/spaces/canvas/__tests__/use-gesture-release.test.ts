// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The safety net that ends a gesture xyflow never reported a stop for (#2010).
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGestureRelease } from '@web/spaces/canvas/use-gesture-release';

/**
 * A stand-in for the gesture's abandon, counting the calls it takes. Whether
 * there is anything to drop is the gesture's own answer, pinned in
 * `use-gesture-broadcast.test.ts`; this hook only says when to ask.
 * @returns The abandon to hand the hook and the count of calls it took.
 */
function watched(): { abandon: () => void; abandons: () => number } {
  let count = 0;
  return {
    abandon: () => {
      count += 1;
    },
    abandons: () => count,
  };
}

describe('useGestureRelease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  // The whole web suite runs in ONE process (`singleFork`), so a fake clock
  // left standing is the clock every later file gets. React's scheduler then
  // never advances, nothing flushes, and every render in the run after this
  // file produces an empty body -- which is what CI showed: 68 files failing
  // on `Unable to find an element` against `<body><div /></body>`. Locally the
  // same suite was green, because the file order put this one last.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a gesture the pointer release left standing', () => {
    const gesture = watched();
    renderHook(() => useGestureRelease(gesture.abandon));
    window.dispatchEvent(new PointerEvent('pointerup'));
    vi.runAllTimers();
    expect(gesture.abandons()).toBe(1);
  });

  it('drops a gesture on a cancelled pointer', () => {
    const gesture = watched();
    renderHook(() => useGestureRelease(gesture.abandon));
    window.dispatchEvent(new PointerEvent('pointercancel'));
    vi.runAllTimers();
    expect(gesture.abandons()).toBe(1);
  });

  it('drops a gesture on the first move with no button held', () => {
    // A mouse released outside the window delivers no pointerup to the page,
    // and xyflow's drag takes no pointer capture — so the release itself can
    // go missing and this is the signal that closes that whole class.
    const gesture = watched();
    renderHook(() => useGestureRelease(gesture.abandon));
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }));
    expect(gesture.abandons()).toBe(1);
  });

  it('leaves a gesture alone while a button is still held', () => {
    const gesture = watched();
    renderHook(() => useGestureRelease(gesture.abandon));
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1 }));
    expect(gesture.abandons()).toBe(0);
  });

  it('drops a gesture when the window loses focus', () => {
    // Releasing outside the window and then going to another application
    // delivers neither a release nor a move to this page, so without this the
    // gesture stands and freezes those nodes on every other screen for as long
    // as this client stays connected.
    const gesture = watched();
    renderHook(() => useGestureRelease(gesture.abandon));
    window.dispatchEvent(new Event('blur'));
    expect(gesture.abandons()).toBe(1);
  });

  it('stops listening once unmounted', () => {
    const gesture = watched();
    const { unmount } = renderHook(() => useGestureRelease(gesture.abandon));
    unmount();
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }));
    window.dispatchEvent(new Event('blur'));
    expect(gesture.abandons()).toBe(0);
  });
});
