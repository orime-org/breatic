// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The clock behind a running task's two counters (#186 §7.3).
 *
 * Elapsed and remaining are derived every second from what the server
 * decided, so the reader needs a clock that moves. Nothing else on the panel
 * does, so it stops the moment no row is counting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useTickingClock } from '@web/spaces/canvas/tasks/use-ticking-clock';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTickingClock', () => {
  it('starts at the reader’s clock', () => {
    const { result } = renderHook(() => useTickingClock(true));

    expect(result.current).toBe(Date.parse('2026-09-04T10:00:00.000Z'));
  });

  it('advances once a second while something is counting', () => {
    const { result } = renderHook(() => useTickingClock(true));

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current).toBe(Date.parse('2026-09-04T10:00:02.000Z'));
  });

  it('stands still when no row is counting', () => {
    // The three settled states show fixed instants, so a timer running
    // behind them would re-render the panel every second for nothing.
    const { result } = renderHook(() => useTickingClock(false));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current).toBe(first);
  });

  it('picks the clock back up when a row starts counting again', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useTickingClock(active),
      { initialProps: { active: false } },
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender({ active: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toBe(Date.parse('2026-09-04T10:00:04.000Z'));
  });
});
