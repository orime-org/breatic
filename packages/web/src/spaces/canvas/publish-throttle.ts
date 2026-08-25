// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** A run that has been asked for and not happened yet. */
export interface PublishThrottle {
  /** Ask for a run; repeat calls before it happens fold into that one run. */
  schedule: () => void;
  /** Drop whatever is waiting, and let later calls start over. */
  cancel: () => void;
}

/**
 * Rate-limit one function to at most one run per frame and per interval.
 *
 * Two layers, because each catches what the other cannot. The frame folds
 * together everything asked for within it, which is what a rubber-band drag
 * produces — every pointer move genuinely changes the holding, so comparing
 * values damps nothing. The interval then caps the rate: awareness resends the
 * whole state on every field write, so one high-frequency field makes the
 * whole state high-frequency, and 33ms is where Excalidraw and tldraw both
 * put that cap.
 * @param run - What to run.
 * @param minIntervalMs - The shortest gap allowed between two runs.
 * @returns The handle to ask for runs and to drop them.
 */
export function createPublishThrottle(
  run: () => void,
  minIntervalMs: number,
): PublishThrottle {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRunAt = Number.NEGATIVE_INFINITY;

  /** Run now and open the next interval. */
  const fire = (): void => {
    frame = null;
    timer = null;
    lastRunAt = Date.now();
    run();
  };

  /** Ask for a run, folding into whatever is already waiting. */
  const schedule = (): void => {
    if (frame !== null || timer !== null) return;
    const waitMs = minIntervalMs - (Date.now() - lastRunAt);
    // Waiting out the interval folds this frame's callers together on its own,
    // so the wait replaces the frame rather than preceding it: adding one
    // would stretch every capped run by a frame and lower the real ceiling.
    if (waitMs > 0) {
      timer = setTimeout(fire, waitMs);
      return;
    }
    frame = requestAnimationFrame(fire);
  };

  /** Drop the pending run, leaving the interval clock where it is. */
  const cancel = (): void => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { schedule, cancel };
}
