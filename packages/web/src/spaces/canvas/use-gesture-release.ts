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
 * prompt one. A move with no button held catches a mouse released outside the
 * window, which delivers no release to the page and which d3-drag takes no
 * pointer capture for — the same reasoning the lock-drag detector in
 * `CanvasSpace.tsx` already runs on. Losing focus catches the rest of that
 * class: released outside and then away to another window, where no move ever
 * comes back to say the button is up.
 *
 * None of the three is authoritative about whether xyflow will still report
 * its stop, so every one of them waits a task before acting. xyflow's drag
 * runs on d3-drag, which ends on `mouseup` (`d3-drag/src/drag.js:56`), and a
 * device can say the button is up before that arrives: recorded on a fast
 * drag, `pointermove buttons=0` at 4501898ms, then `pointerup` and `mouseup`
 * together at 4501904ms. Acting on the move the instant it arrives dropped the
 * gesture 6ms before the stop that writes the document, and the node sprang
 * back to where the document still had it (#2151). One task is the whole
 * distance between them, so waiting it lets a normally-ended gesture write and
 * be gone — `abandon` is a no-op with none running — while a release the page
 * never saw still gets dropped.
 *
 * This hook says when to drop, and the gesture itself says whether there is
 * anything to drop.
 * @param abandon - Drop the gesture with no final value.
 */
export function useGestureRelease(abandon: () => void): void {
  React.useEffect(() => {
    const pending = new Set<number>();
    /** Give xyflow's own stop the next task to run first, then drop. */
    const dropSoon = (): void => {
      const timer = window.setTimeout(() => {
        pending.delete(timer);
        abandon();
      }, 0);
      pending.add(timer);
    };
    /**
     * Drop a gesture whose release never reached the page.
     * @param event - The pointer move.
     */
    const onMove = (event: PointerEvent): void => {
      if (event.buttons === 0) dropSoon();
    };
    window.addEventListener('pointerup', dropSoon);
    window.addEventListener('pointercancel', dropSoon);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('blur', dropSoon);
    return (): void => {
      window.removeEventListener('pointerup', dropSoon);
      window.removeEventListener('pointercancel', dropSoon);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('blur', dropSoon);
      // A drop already scheduled would otherwise land on a canvas that is gone
      // and publish awareness from it.
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, [abandon]);
}
