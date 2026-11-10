// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Escape, as a Space answers it.
 *
 * Several modes end on Escape — on the canvas a pick session with no overlay
 * of its own, the armed annotation tool and the open tool panels; in a
 * document a table open full screen — and the press each has to accept is the
 * same press, down to six conditions nobody would think to re-derive. Two
 * copies is two chances for the next mode to inherit five of the six.
 */

import * as React from 'react';

import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';
import { compositionEnd } from '@web/lib/composition-end';

/**
 * Whether a key press is an Escape nobody else has a claim on: not taken by an
 * earlier listener, not a held key's repeat, and not ending an input method's
 * composition. Which region the press belongs to is a separate question.
 * @param e - The keyboard event.
 * @returns True for such a press.
 * @throws {never} Never.
 */
export function isFreeEscape(e: KeyboardEvent): boolean {
  return e.key === 'Escape' && !e.defaultPrevented && !e.repeat && !e.isComposing && e.keyCode !== 229;
}

/**
 * Call `onEscape` when Escape is pressed and this Space is the one it means.
 *
 * `defaultPrevented` is what makes Escape peel one layer at a time: whoever
 * prevented the default owns the press, so an open tooltip dismisses on the
 * first press and the mode ends on the next. The three IME conditions keep a
 * press that is dismissing a candidate window from ending the mode behind it —
 * `isComposing` says so on the keystroke, `keyCode === 229` is the same
 * answer from engines that report the composition without it, and the Escape
 * Chrome sends again right after a composition ends, anywhere on the page,
 * carries neither and is claimed by queue order.
 * @param active - Whether there is a mode to end. No listener while false.
 * @param onEscape - What to end. Stable, or the listener is rebound per render.
 */
export function useEscapeInSpace(active: boolean, onEscape: () => void): void {
  React.useEffect(() => {
    if (!active) return;
    const ended = compositionEnd();
    /**
     * Keydown listener ending the mode on a press that belongs to it.
     * @param e - The keyboard event.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!isFreeEscape(e) || ended.justEnded() || !regionOwnsKeyboard(e.target, 'space')) return;
      // Claim it. `defaultPrevented` above is how Escape peels one layer at a
      // time, and a mode that acts without setting it leaves the next listener
      // reading the press as untouched — which is what let one key both disarm
      // the note tool and collapse an open sticky.
      e.preventDefault();
      onEscape();
    };
    window.addEventListener('compositionend', ended.mark, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('compositionend', ended.mark, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [active, onEscape]);
}
