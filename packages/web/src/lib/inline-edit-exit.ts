// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { compositionEnd, keyBelongsToInputMethod } from '@web/lib/composition-end';

/** {@link useInlineEditExit} inputs. */
export interface InlineEditExitOptions {
  /** Whether the inline box is on screen. */
  editing: boolean;
  /**
   * The element the keyboard goes to once a key has ended the edit, read after
   * the box is gone; null leaves the focus where it is.
   */
  target: () => HTMLElement | null;
  /** The site's own commit; it closes the box. */
  commit: () => void;
  /** The site's own cancel; it closes the box. */
  cancel: () => void;
  /** Stop every key at the box, for a box that sits inside another control. */
  isolate?: boolean;
}

/** The handlers {@link useInlineEditExit} gives the box. */
export interface InlineEditExit {
  /** The box's keydown. */
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** The box's compositionend. */
  onCompositionEnd: () => void;
}

/**
 * Swallows the auto-repeats of a key that is still held, until it is released
 * or the window loses focus. The key that ended an edit keeps repeating after
 * the keyboard has moved on, and the element it moved to may act on that key
 * (a title opens for editing on Enter, a text node opens its body); one press
 * acts once, as the canvas's own one-shot keys do.
 * @param key - The `KeyboardEvent.key` being held.
 * @returns The function that stops swallowing.
 */
function swallowRepeatsOf(key: string): () => void {
  /**
   * Swallows a repeat of the held key before anything below the window sees it.
   * @param event - The keydown.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== key || !event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
  };
  /**
   * Stops on the release of the held key.
   * @param event - The keyup.
   */
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === key) release();
  };
  /** Removes the listeners. */
  const release = (): void => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', release);
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', release);
  return release;
}

/**
 * How an inline rename box ends from the keyboard, the same for every one of
 * them: Enter commits and Escape cancels, both consume the key, and the
 * keyboard then goes to `target` -- the box unmounts while holding the focus,
 * and nothing else would put it anywhere. Consuming Enter also keeps the
 * browser from turning the keystroke into a click on whatever takes the focus,
 * and the key's auto-repeats are kept from reaching it while the key is held.
 *
 * A key that belongs to an input method (accepting a candidate, closing the
 * candidate list) is consumed and ends nothing. Leaving the box ends the edit
 * through the site's own blur, and the focus stays where the reader took it.
 * @param root0 - What the box does and where the keyboard goes.
 * @param root0.editing - Whether the box is on screen.
 * @param root0.target - Where the keyboard goes after a key ends the edit.
 * @param root0.commit - The site's commit.
 * @param root0.cancel - The site's cancel.
 * @param root0.isolate - Stop every key at the box.
 * @returns The box's handlers.
 */
export function useInlineEditExit({
  editing,
  target,
  commit,
  cancel,
  isolate = false,
}: InlineEditExitOptions): InlineEditExit {
  const ended = React.useMemo(compositionEnd, []);
  // Set only by a key that ends the edit, and every commit and cancel closes
  // the box, so a close that finds it set was caused by that key.
  const handBack = React.useRef(false);
  const releaseHeld = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    if (editing || !handBack.current) return;
    handBack.current = false;
    target()?.focus({ preventScroll: true });
  }, [editing, target]);

  React.useEffect(() => () => releaseHeld.current?.(), []);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (isolate) event.stopPropagation();
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      if (keyBelongsToInputMethod(event.nativeEvent, ended)) return;
      handBack.current = true;
      releaseHeld.current?.();
      releaseHeld.current = swallowRepeatsOf(event.key);
      if (event.key === 'Enter') commit();
      else cancel();
    },
    [isolate, ended, commit, cancel],
  );

  return { onKeyDown, onCompositionEnd: ended.mark };
}
