// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The safety net that ends a gesture xyflow never reported a stop for (#2010).
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGestureRelease } from '@web/spaces/canvas/use-gesture-release';

/**
 * A stand-in for the gesture the hook watches.
 * @param running - Whether a gesture is currently held.
 * @returns The stand-in and the count of abandons it recorded.
 */
function watched(running: boolean): {
  isRunning: () => boolean;
  abandon: () => void;
  abandons: () => number;
} {
  let count = 0;
  return {
    isRunning: () => running,
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

  it('drops a gesture the pointer release left standing', () => {
    const gesture = watched(true);
    renderHook(() => useGestureRelease(gesture));
    window.dispatchEvent(new PointerEvent('pointerup'));
    vi.runAllTimers();
    expect(gesture.abandons()).toBe(1);
  });

  it('leaves a gesture alone when the release already ended it', () => {
    const gesture = watched(false);
    renderHook(() => useGestureRelease(gesture));
    window.dispatchEvent(new PointerEvent('pointerup'));
    vi.runAllTimers();
    expect(gesture.abandons()).toBe(0);
  });

  it('drops a gesture on a cancelled pointer', () => {
    const gesture = watched(true);
    renderHook(() => useGestureRelease(gesture));
    window.dispatchEvent(new PointerEvent('pointercancel'));
    vi.runAllTimers();
    expect(gesture.abandons()).toBe(1);
  });

  it('drops a gesture on the first move with no button held', () => {
    // A mouse released outside the window delivers no pointerup to the page,
    // and xyflow's drag takes no pointer capture — so the release itself can
    // go missing and this is the signal that closes that whole class.
    const gesture = watched(true);
    renderHook(() => useGestureRelease(gesture));
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }));
    expect(gesture.abandons()).toBe(1);
  });

  it('leaves a gesture alone while a button is still held', () => {
    const gesture = watched(true);
    renderHook(() => useGestureRelease(gesture));
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1 }));
    expect(gesture.abandons()).toBe(0);
  });

  it('drops a gesture when the window loses focus', () => {
    // Releasing outside the window and then going to another application
    // delivers neither a release nor a move to this page, so without this the
    // gesture stands and freezes those nodes on every other screen for as long
    // as this client stays connected.
    const gesture = watched(true);
    renderHook(() => useGestureRelease(gesture));
    window.dispatchEvent(new Event('blur'));
    expect(gesture.abandons()).toBe(1);
  });

  it('stops listening once unmounted', () => {
    const gesture = watched(true);
    const { unmount } = renderHook(() => useGestureRelease(gesture));
    unmount();
    window.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }));
    window.dispatchEvent(new Event('blur'));
    expect(gesture.abandons()).toBe(0);
  });
});
