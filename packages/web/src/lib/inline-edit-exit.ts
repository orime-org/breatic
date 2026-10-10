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
  /** Stop every key at the box, for a box inside a control that reads keys. */
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
 * How an inline rename box ends from the keyboard, the same for every one of
 * them: Enter commits and Escape cancels, both consume the key, and the
 * keyboard then goes to `target` -- the box unmounts while holding the focus,
 * and nothing else would put it anywhere. Consuming Enter also keeps the
 * browser from turning the keystroke into a click on whatever takes the focus.
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
  const handBack = React.useRef(false);
  const wasEditing = React.useRef(editing);

  React.useEffect(() => {
    const closed = wasEditing.current && !editing;
    wasEditing.current = editing;
    if (!closed) return;
    const byKey = handBack.current;
    handBack.current = false;
    if (byKey) target()?.focus({ preventScroll: true });
  }, [editing, target]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (isolate) event.stopPropagation();
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      if (keyBelongsToInputMethod(event.nativeEvent, ended)) return;
      handBack.current = true;
      if (event.key === 'Enter') commit();
      else cancel();
    },
    [isolate, ended, commit, cancel],
  );

  return { onKeyDown, onCompositionEnd: ended.mark };
}
