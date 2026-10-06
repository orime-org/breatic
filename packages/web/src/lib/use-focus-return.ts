// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * Whether the caret goes back into an editor when it is shown again. Kept by
 * the caller beside whatever outlives the component — an editor kept across
 * mounts carries its own, so a return still waiting when the component
 * unmounts again reaches the next mount.
 */
export interface FocusReturn {
  /** The caret was in the editor when it was last hidden. */
  hadFocus: boolean;
  /** A return is scheduled and has not run yet. */
  returning: boolean;
}

/**
 * Puts the caret back into an editor shown again after a switch of Space, if
 * it was there when the Space was hidden.
 *
 * Read in a layout cleanup, which runs before hiding moves the editor off the
 * page and focus with it. Put back a task later, the way an editor's own
 * autofocus waits: a mount undone straight away (Strict Mode) moves the
 * editor out of the page again, and focus put in before that would be lost
 * and read as the reader leaving.
 * @param memo - Where the answer is kept, or undefined when there is nothing
 *   to put the caret back into.
 * @param hasFocus - Whether the caret is in the editor now.
 * @param focus - Puts the caret back.
 */
export function useFocusReturn(
  memo: FocusReturn | undefined,
  hasFocus: () => boolean,
  focus: () => void,
): void {
  const latest = React.useRef({ hasFocus, focus });
  latest.current = { hasFocus, focus };
  React.useLayoutEffect(
    () => () => {
      if (memo !== undefined) memo.hadFocus = latest.current.hasFocus() || memo.returning;
    },
    [memo],
  );
  React.useEffect(() => {
    if (memo === undefined || !memo.hadFocus) return undefined;
    memo.returning = true;
    const id = window.setTimeout(() => {
      memo.returning = false;
      if (!latest.current.hasFocus()) latest.current.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [memo]);
}
