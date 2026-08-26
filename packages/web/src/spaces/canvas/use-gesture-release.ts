// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/** The part of a running gesture this net needs to see. */
export interface ReleasableGesture {
  /** Whether a gesture is currently held. */
  isRunning: () => boolean;
  /** Drop the gesture with no final value. */
  abandon: () => void;
}

/**
 * End a gesture that xyflow never reported a stop for.
 *
 * xyflow drops a drag without firing a stop for any node of the batch when the
 * grabbed node leaves its lookup (`@xyflow/system:2237` and `:2264`), and a
 * marquee drag has no grabbed node in the first place — it hands the callbacks
 * the batch's first node instead (`:2044`). Left standing, the gesture field
 * freezes those nodes on every other screen for as long as this client stays
 * connected, so something has to notice the pointer is no longer down.
 *
 * Two signals, because neither covers the other. The release is the prompt one.
 * xyflow's drag runs on d3-drag, which listens for `mouseup` (`d3-drag/src/
 * drag.js:56`) — the compatibility event the browser fires right after
 * `pointerup`, in the same task. Checking on the next task lets that stop run
 * first, so a gesture that ended normally is already gone by the time this
 * looks. A move with no button held is the one that closes the class: a mouse
 * released outside the window delivers neither event to the page, and d3-drag
 * takes no pointer capture — the same reasoning the lock-drag detector in
 * `CanvasSpace.tsx` already runs on.
 * @param gesture - The gesture to watch.
 */
export function useGestureRelease(gesture: ReleasableGesture): void {
  React.useEffect(() => {
    /** Drop a gesture the pointer release left standing. */
    const onRelease = (): void => {
      window.setTimeout(() => {
        if (!gesture.isRunning()) return;
        gesture.abandon();
      }, 0);
    };
    /**
     * Drop a gesture whose release never reached the page.
     * @param event - The pointer move.
     */
    const onMove = (event: PointerEvent): void => {
      if (event.buttons !== 0) return;
      if (!gesture.isRunning()) return;
      gesture.abandon();
    };
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    window.addEventListener('pointermove', onMove);
    return (): void => {
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
      window.removeEventListener('pointermove', onMove);
    };
  }, [gesture]);
}
