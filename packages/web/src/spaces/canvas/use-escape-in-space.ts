// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Escape, as the canvas answers it.
 *
 * Two modes on this canvas end on Escape — a pick session with no overlay of
 * its own, and the armed annotation tool — and the press each has to accept is
 * the same press, down to five conditions nobody would think to re-derive. Two
 * copies is two chances for the next mode to inherit four of the five.
 */

import * as React from 'react';

import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';

/**
 * Call `onEscape` when Escape is pressed and this canvas is the one it means.
 *
 * `defaultPrevented` is what makes Escape peel one layer at a time: whoever
 * prevented the default owns the press, so an open tooltip dismisses on the
 * first press and the mode ends on the next. The three IME conditions keep a
 * press that is dismissing a candidate window from ending the mode behind it —
 * `isComposing` says so on the keystroke, and `keyCode === 229` is the same
 * answer from engines that report the composition without it.
 * @param active - Whether there is a mode to end. No listener while false.
 * @param onEscape - What to end. Stable, or the listener is rebound per render.
 */
export function useEscapeInSpace(active: boolean, onEscape: () => void): void {
  React.useEffect(() => {
    if (!active) return;
    /**
     * Keydown listener ending the mode on a press that belongs to it.
     * @param e - The keyboard event.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        e.repeat ||
        e.isComposing ||
        e.keyCode === 229
      ) {
        return;
      }
      if (!regionOwnsKeyboard(e.target, 'space')) return;
      // Claim it. `defaultPrevented` above is how Escape peels one layer at a
      // time, and a mode that acts without setting it leaves the next listener
      // reading the press as untouched — which is what let one key both disarm
      // the note tool and collapse an open sticky.
      e.preventDefault();
      onEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, onEscape]);
}
