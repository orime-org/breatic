// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPublishThrottle } from '@web/spaces/canvas/publish-throttle';

/** The frame length the fake timers run animation callbacks at. */
const FRAME_MS = 16;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPublishThrottle', () => {
  it('runs nothing until a frame passes', () => {
    const run = vi.fn();
    createPublishThrottle(run, 33).schedule();

    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FRAME_MS);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('folds everything asked for within one frame into a single run', () => {
    // A rubber-band drag genuinely changes the holding on every pointer move,
    // which de-duplication cannot damp because each value really is new.
    const run = vi.fn();
    const throttle = createPublishThrottle(run, 33);

    throttle.schedule();
    throttle.schedule();
    throttle.schedule();
    vi.advanceTimersByTime(FRAME_MS);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('holds the next run back to the minimum interval', () => {
    const run = vi.fn();
    const throttle = createPublishThrottle(run, 33);
    throttle.schedule();
    vi.advanceTimersByTime(FRAME_MS);

    // Asking again right after that run: the whole interval is still to go.
    throttle.schedule();
    vi.advanceTimersByTime(32);
    expect(run).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('caps a continuous stream at the minimum interval', () => {
    const run = vi.fn();
    const throttle = createPublishThrottle(run, 33);

    // Ask on every frame for a second, the way a moving pointer does.
    for (let elapsed = 0; elapsed < 1000; elapsed += FRAME_MS) {
      throttle.schedule();
      vi.advanceTimersByTime(FRAME_MS);
    }

    expect(run.mock.calls.length).toBeLessThanOrEqual(1000 / 33 + 1);
    expect(run.mock.calls.length).toBeGreaterThan(1000 / 33 - 5);
  });

  it('runs on the next frame once the interval has already passed', () => {
    const run = vi.fn();
    const throttle = createPublishThrottle(run, 33);
    throttle.schedule();
    vi.advanceTimersByTime(FRAME_MS);

    vi.advanceTimersByTime(100);
    throttle.schedule();
    vi.advanceTimersByTime(FRAME_MS);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('drops a pending frame when cancelled', () => {
    const run = vi.fn();
    const throttle = createPublishThrottle(run, 33);
    throttle.schedule();

    throttle.cancel();
    vi.advanceTimersByTime(1000);

    expect(run).not.toHaveBeenCalled();
  });

  it('drops a run still waiting out the interval when cancelled', () => {
    // Leaving the space during the wait must not publish afterwards: by then
    // the withdrawal has already been written.
    const run = vi.fn();
    const throttle = createPublishThrottle(run, 33);
    throttle.schedule();
    vi.advanceTimersByTime(FRAME_MS);
    throttle.schedule();

    throttle.cancel();
    vi.advanceTimersByTime(1000);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('takes work again after a cancel', () => {
    const run = vi.fn();
    const throttle = createPublishThrottle(run, 33);
    throttle.schedule();
    throttle.cancel();

    vi.advanceTimersByTime(100);
    throttle.schedule();
    vi.advanceTimersByTime(FRAME_MS);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
