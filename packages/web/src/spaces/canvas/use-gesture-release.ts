// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

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
 * Three signals, each covering what the others cannot. The release is the
 * prompt one. xyflow's drag runs on d3-drag, which listens for `mouseup`
 * (`d3-drag/src/drag.js:56`) — the compatibility event the browser fires right
 * after `pointerup`, in the same task. Checking on the next task lets that stop
 * run first, so a gesture that ended normally is already gone by the time this
 * looks. A move with no button held catches a mouse released outside the
 * window, which delivers neither event to the page and which d3-drag takes no
 * pointer capture for — the same reasoning the lock-drag detector in
 * `CanvasSpace.tsx` already runs on. Losing focus catches the rest of that
 * class: released outside and then away to another window, where no move ever
 * comes back to say the button is up.
 *
 * This hook says when to drop, and the gesture itself says whether there is
 * anything to drop — `abandon` is a no-op with none running.
 * @param abandon - Drop the gesture with no final value.
 */
export function useGestureRelease(abandon: () => void): void {
  React.useEffect(() => {
    /** Give xyflow's own stop the next task to run first, then drop. */
    const onRelease = (): void => {
      window.setTimeout(abandon, 0);
    };
    /**
     * Drop a gesture whose release never reached the page.
     * @param event - The pointer move.
     */
    const onMove = (event: PointerEvent): void => {
      if (event.buttons === 0) abandon();
    };
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('blur', abandon);
    return (): void => {
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('blur', abandon);
    };
  }, [abandon]);
}
