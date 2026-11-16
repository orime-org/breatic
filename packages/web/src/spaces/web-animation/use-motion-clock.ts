// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/** The play bar's clock over one result. */
export interface MotionClock {
  /** Where the playhead is, in seconds of the result. */
  time: number;
  playing: boolean;
  toggle: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
}

/**
 * The play bar's clock (#1490 design §7.1): it runs on animation frames while playing, stops at the end, and starts
 * over at zero when the result changes. Play at the end starts from the beginning.
 * @param durationSeconds - The result's length; zero has nothing to play.
 * @param resultKey - The shown result; a change resets the clock.
 * @returns The clock.
 * @throws {never} Never.
 */
export function useMotionClock(durationSeconds: number, resultKey: string | null): MotionClock {
  const [time, setTime] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [shown, setShown] = React.useState(resultKey);
  if (shown !== resultKey) {
    setShown(resultKey);
    setTime(0);
    setPlaying(false);
  }
  React.useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now: number): void {
      const elapsed = (now - last) / 1000;
      last = now;
      setTime((current) => {
        const next = current + elapsed;
        if (next >= durationSeconds) {
          setPlaying(false);
          return durationSeconds;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, durationSeconds]);
  const toggle = React.useCallback((): void => {
    if (durationSeconds <= 0) return;
    setPlaying((now) => {
      if (!now) setTime((current) => (current >= durationSeconds ? 0 : current));
      return !now;
    });
  }, [durationSeconds]);
  const pause = React.useCallback((): void => setPlaying(false), []);
  const seek = React.useCallback((seconds: number): void => {
    setPlaying(false);
    setTime(Math.min(Math.max(0, seconds), durationSeconds));
  }, [durationSeconds]);
  return React.useMemo(() => ({ time, playing, toggle, pause, seek }), [time, playing, toggle, pause, seek]);
}
