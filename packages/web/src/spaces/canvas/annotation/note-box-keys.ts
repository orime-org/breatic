// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The keys and the composition a note's text box answers, in the one place all
 * three take them.
 *
 * A note has three boxes — the one that places it, the one that rewrites a
 * line, the one that replies — and every one of them reads the same keystrokes
 * the same way. Written per box, the third copy is where a rule starts to
 * drift: one of them already grew a condition the other two never got, and the
 * only reason it stayed correct is that somebody happened to notice.
 *
 * Escape reaches this only while the box has something to drop. The press the
 * canvas itself answers is a different rule with its own conditions, and it
 * lives in `use-escape-in-space.ts`.
 */

import * as React from 'react';

import type { DraftAction } from '@web/stores/annotation-draft';

/** What a note's box needs on its element, plus the IME question its panel asks. */
export interface NoteBox {
  /** Spread onto the `Textarea`. */
  box: {
    onKeyDown: (event: React.KeyboardEvent) => void;
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  /** Whether an IME is composing in this box right now. */
  composing: () => boolean;
}

/**
 * Answer Enter, Shift+Enter and Escape on a note's text box, and track whether
 * an IME is composing in it.
 *
 * Enter keeps what is written and Shift+Enter is a line inside it. Escape
 * drops it, and stops there: the canvas listens for Escape too, and left to
 * carry on the same press would collapse the sticky behind the box it just
 * closed.
 *
 * §6.2 answers the IME with one criterion — while a composition is running,
 * nothing commits — and this is where that criterion lives, because a box has
 * more ways out than its keyboard: a Save button, a Cancel button, a blur. A
 * keystroke carries the answer itself (`KeyboardEvent.isComposing`, [W3C UI
 * Events](https://www.w3.org/TR/uievents/#dom-keyboardevent-iscomposing)); a
 * press and a blur carry nothing, so the composition events are what the panel
 * around the box reads through `composing`. Held in a ref: the value is read
 * inside event handlers, and a re-render per keystroke of a composition would
 * buy nothing.
 * @param dispatch - Where this box sends what the key means.
 * @param escapeIsMine - Whether this box has something to drop on Escape. A
 *   box with nothing in it lets the press through to the canvas. Default: the
 *   box always takes it.
 * @returns The handlers for the box and the IME question for its panel.
 */
export function useNoteBox(
  dispatch: (action: DraftAction) => void,
  escapeIsMine: () => boolean = () => true,
): NoteBox {
  const composingRef = React.useRef(false);
  const dispatchRef = React.useRef(dispatch);
  dispatchRef.current = dispatch;
  const escapeIsMineRef = React.useRef(escapeIsMine);
  escapeIsMineRef.current = escapeIsMine;

  return React.useMemo(
    () => ({
      box: {
        onKeyDown: (event: React.KeyboardEvent): void => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            dispatchRef.current({ type: 'save' });
            return;
          }
          if (event.key === 'Escape') {
            if (!escapeIsMineRef.current()) return;
            event.stopPropagation();
            dispatchRef.current({ type: 'escape' });
          }
        },
        onCompositionStart: (): void => {
          composingRef.current = true;
        },
        onCompositionEnd: (): void => {
          composingRef.current = false;
        },
      },
      composing: (): boolean => composingRef.current,
    }),
    [],
  );
}
