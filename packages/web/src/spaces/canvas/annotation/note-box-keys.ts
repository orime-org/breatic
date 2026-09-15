// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The keys a note's text box answers, in the one place all three take them.
 *
 * A note has three boxes — the one that places it, the one that rewrites a
 * line, the one that replies — and every one of them reads the same three
 * keystrokes the same way. Written per box, the third copy is where a rule
 * starts to drift: one of them already grew a condition the other two never
 * got, and the only reason it stayed correct is that somebody happened to
 * notice.
 *
 * Escape reaches this only while the box has something to drop. The press the
 * canvas itself answers is a different rule with its own conditions, and it
 * lives in `use-escape-in-space.ts`.
 */

import type * as React from 'react';

import type { DraftAction } from '@web/stores/annotation-draft';

/**
 * Answer Enter, Shift+Enter and Escape on a note's text box.
 *
 * Enter keeps what is written and Shift+Enter is a line inside it. Escape
 * drops it, and stops there: the canvas listens for Escape too, and left to
 * carry on the same press would collapse the sticky behind the box it just
 * closed. A keystroke an IME is composing with belongs to the IME — Enter is
 * picking a candidate, Escape is dismissing the candidate window — and reaches
 * none of this.
 * @param dispatch - Where this box sends what the key means.
 * @param escapeIsMine - Whether this box has something to drop on Escape. A
 *   box with nothing in it lets the press through to the canvas. Default: the
 *   box always takes it.
 * @returns The `onKeyDown` handler for the box.
 */
export function noteBoxKeys(
  dispatch: (action: DraftAction) => void,
  escapeIsMine: () => boolean = () => true,
): (event: React.KeyboardEvent) => void {
  return (event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      dispatch({ type: 'save' });
      return;
    }
    if (event.key === 'Escape') {
      if (!escapeIsMine()) return;
      event.stopPropagation();
      dispatch({ type: 'escape' });
    }
  };
}
