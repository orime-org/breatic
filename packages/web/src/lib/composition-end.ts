// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The key that ends an input method composition, told apart from a key the
 * reader presses afterwards.
 *
 * An input method accepts a candidate with Enter and dismisses its list with
 * Escape, and nothing in the keydown says so for certain: Chrome sends
 * `compositionend` first and then the key with `isComposing: false`, once as
 * 229 and again as 13 (measured in a browser, `document-enter.ts`). So the
 * end is marked, and the mark is released only after whatever the browser has
 * already queued for that keystroke has run. A press the reader makes later is
 * queued behind the release; a window of time instead would swallow it, and
 * pressing Enter right after accepting a candidate is how writing Chinese goes.
 */

/** One place's view of composition ends. */
export interface CompositionEnd {
  /** Called on `compositionend`. */
  readonly mark: () => void;
  /**
   * Whether a composition has just ended and its keystroke may still be
   * arriving.
   */
  readonly justEnded: () => boolean;
}

/**
 * A fresh tracker.
 * @returns The tracker.
 */
export function compositionEnd(): CompositionEnd {
  let ended = false;
  return {
    mark: () => {
      ended = true;
      setTimeout(() => {
        ended = false;
      }, 0);
    },
    justEnded: () => ended,
  };
}

/**
 * Whether a key belongs to an input method rather than to the field it is
 * typed into.
 * @param event - The keydown.
 * @param ended - The field's composition ends.
 * @returns True while composing, for the key reported as 229, and for the key
 *   that ends a composition.
 */
export function keyBelongsToInputMethod(
  event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>,
  ended: CompositionEnd,
): boolean {
  return event.isComposing || event.keyCode === 229 || ended.justEnded();
}
