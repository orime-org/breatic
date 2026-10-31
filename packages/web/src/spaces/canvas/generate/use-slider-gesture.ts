// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

interface SliderGestureOptions {
  /** The stored value. */
  value: number | undefined;
  /** A value to show in place of `value` without writing it. */
  draft?: number | undefined;
  /** Called with the value the thumb is moved to, before it is written. */
  onDraft?: ((value: number) => void) | undefined;
  /** Called whenever the draft is dropped. */
  onDraftEnd?: (() => void) | undefined;
  /** Called with the value a gesture ends on, once per gesture. */
  onCommit: (value: number) => void;
}

/** What the slider shows, and the handlers that drive it. */
export interface SliderGesture {
  shown: number | undefined;
  handlers: {
    onValueChange: (values: number[]) => void;
    onValueCommit: (values: number[]) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onKeyUp: () => void;
    onBlur: () => void;
    onPointerDown: () => void;
    onLostPointerCapture: () => void;
  };
}

/**
 * A Radix slider written once per gesture: the thumb follows the pointer or
 * the key while the stored value waits for the gesture to end.
 *
 * A drag crosses every step between where it starts and where it ends, and
 * Radix reports each one. Each report written straight through is one canvas
 * undo entry — that stack holds 50 and merges nothing by time — so a single
 * drag across a 100-step range could push out everything the user could still
 * undo. `onValueCommit` fires once when a gesture ends and once per key press,
 * which is the granularity a person would name as one change.
 * @param options - The stored value, the draft and the callbacks.
 * @param options.value - The stored value.
 * @param options.draft - A value to show without writing it.
 * @param options.onDraft - Called with the value the thumb is moved to.
 * @param options.onDraftEnd - Called whenever the draft is dropped.
 * @param options.onCommit - Called with the value a gesture ends on.
 * @returns The value to show and the slider's handlers.
 */
export function useSliderGesture({ value, draft, onDraft, onDraftEnd, onCommit }: SliderGestureOptions): SliderGesture {
  // Where the thumb sits until the gesture ends. Held apart from `value` so
  // the control follows the pointer while the document does not.
  const [dragged, setDragged] = React.useState<number | null>(null);
  const shown = dragged ?? draft ?? value;

  // A key the browser is repeating, and the step the last repeat reached.
  const repeatingRef = React.useRef(false);
  const repeatedToRef = React.useRef<number | null>(null);

  const onValueChange = React.useCallback(
    ([next]: number[]) => {
      setDragged(next ?? null);
      if (next !== undefined) onDraft?.(next);
    },
    [onDraft],
  );

  const onValueCommit = React.useCallback(
    ([next]: number[]) => {
      if (next === undefined) return;
      // Radix commits on every repeat of a held key. The press is the
      // decision and the repeats are it continuing, so they wait for the
      // release rather than each becoming its own undo entry.
      if (repeatingRef.current) {
        repeatedToRef.current = next;
        return;
      }
      setDragged(null);
      onCommit(next);
    },
    [onCommit],
  );

  // Every gesture, by key or by pointer, ends here: the draft and the one
  // handed out go together. Radix reports a keyboard commit BEFORE it reports
  // the change, so a draft cleared inside the commit is written straight
  // back, and a drag released where it began commits nothing; a draft left
  // set shows this client's number over whatever is stored.
  const endDraft = React.useCallback((): void => {
    setDragged(null);
    onDraftEnd?.();
  }, [onDraftEnd]);

  const endKeyGesture = React.useCallback((): void => {
    repeatingRef.current = false;
    const reached = repeatedToRef.current;
    repeatedToRef.current = null;
    // The held key's value is written before the draft ends, so whoever
    // shows the draft ends it on a value that is already the node's.
    if (reached !== null) onCommit(reached);
    endDraft();
  }, [onCommit, endDraft]);

  // Four ways a key gesture ends, and every one of them has to write. Keyup
  // alone leaves the flag set when the release lands on another window, and
  // a set flag holds back every commit after it — the pointer's included, so
  // the thumb would move under drags the node never hears about.
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.repeat) {
        repeatingRef.current = true;
        return;
      }
      endKeyGesture();
    },
    [endKeyGesture],
  );

  const handlers = React.useMemo(
    () => ({
      onValueChange,
      onValueCommit,
      onKeyDown,
      onKeyUp: endKeyGesture,
      onBlur: endKeyGesture,
      onPointerDown: endKeyGesture,
      // Radix commits a moved value in its own pointerup; capture is let go
      // after that, so the draft ends once the commit (if any) is in.
      onLostPointerCapture: endDraft,
    }),
    [onValueChange, onValueCommit, onKeyDown, endKeyGesture, endDraft],
  );
  return { shown, handlers };
}
