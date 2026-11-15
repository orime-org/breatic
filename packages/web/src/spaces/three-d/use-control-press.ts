// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/** One press of a continuous control (a slider drag, a key step, a colour pick). */
export interface ControlPress {
  /**
   * Take a change of the control.
   * @returns Whether the change belongs to an open press; a change never opens one.
   */
  change: () => boolean;
  /** Start a new press when the pointer or a picker arrow key first goes down, ending whatever an earlier press left. */
  begin: () => void;
  /**
   * Take a key on a Slider: a step key is one press of its own, started now and ended once the key's change, if
   * any, has run (Radix reports no change and no commit at a bound).
   * @param event - The key event.
   * @param commit - Ends the press and writes it.
   */
  stepKey: (event: Pick<KeyboardEvent, 'key'>, commit: () => void) => void;
  /**
   * End the press, by its release or by Escape, an undo, or a loss of focus or edit access; its later changes are
   * ignored until the next press starts.
   * @returns Whether its drag was still open: a release then writes it, and an Escape stops there; false for a press
   * already ended, so a second Escape takes its usual step.
   */
  end: () => boolean;
}

/** Keys that move a Radix Slider by themselves. */
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Take a key on a Slider: a step key is one press of its own, started now and ended once the key's change, if any,
 * has run (Radix reports no change and no commit at a bound).
 * @param event - The key event.
 * @param begin - Starts the press.
 * @param commit - Ends the press and writes it.
 * @throws {never} Never.
 */
export function takeStepKey(event: Pick<KeyboardEvent, 'key'>, begin: () => void, commit: () => void): void {
  if (!STEP_KEYS.has(event.key)) return;
  begin();
  // Radix applies the step in the same keydown, after this handler: the press ends once that has run.
  queueMicrotask(commit);
}

/**
 * Track one press of a continuous ambient-light control, which has no session gesture of its own: once Escape, an undo
 * or a loss of focus or edit access ends its drag, every later change of the same press is ignored (design 3.8 and 6.2,
 * the same rule the camera pilot follows). Every press has an explicit start (a
 * pointer down, a step key, a picker arrow key), which ends whatever an earlier press left behind (its control
 * unmounted, or its release came outside the browser).
 * @param open - Opens the drag of a new press; false when it cannot open (no edit access, a locked object).
 * @returns The press.
 */
export function useControlPress(open: () => boolean): ControlPress {
  const held = React.useRef(false);
  return React.useMemo<ControlPress>(() => {
    /** Start a new press, ending whatever an earlier one left behind. */
    const begin = (): void => { held.current = open(); };
    /**
     * End the press.
     * @returns Whether its drag was still open.
     */
    const end = (): boolean => {
      const was = held.current;
      held.current = false;
      return was;
    };
    return {
      begin,
      change: () => held.current,
      stepKey: (event, commit) => { takeStepKey(event, begin, commit); },
      end,
    };
  }, [open]);
}
