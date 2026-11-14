// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/** One press of a continuous control (a slider drag, a key step, a colour pick). */
export interface ControlPress {
  /**
   * Take a change of the control.
   * @returns Whether the change belongs to an open drag; a change with no press yet (a picker key step) opens one.
   */
  change: () => boolean;
  /** Start a new press when the pointer goes down, so undo or Escape before its first change still ends it. */
  begin: () => void;
  /**
   * Start a new press when a key that steps a Slider goes down, so a step never lands in what an earlier press left.
   * @param event - The key event.
   */
  beginOnStepKey: (event: Pick<KeyboardEvent, 'key'>) => void;
  /**
   * End the drag without writing it; the rest of the press is ignored until release.
   * @returns Whether its drag was still open; false for a press already dropped, so a second Escape takes its usual step.
   */
  drop: () => boolean;
  /**
   * End the press.
   * @returns Whether its drag was still open, so the release writes it.
   */
  release: () => boolean;
}

/** Keys that move a Radix Slider by themselves. */
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Track one press of a continuous control: once Escape, a lock or an undo ends its drag, every later change of the same
 * press is ignored until release (design 3.8 and 6.2, the same rule the camera pilot follows). A pointer down or a step
 * key always starts a new press, ending whatever an earlier one left behind (its control unmounted, or its release came
 * outside the browser).
 * @param open - Opens the drag of a new press; false when it cannot open (no edit access, a locked object).
 * @returns The press.
 */
export function useControlPress(open: () => boolean): ControlPress {
  const state = React.useRef<'idle' | 'open' | 'dropped'>('idle');
  return React.useMemo<ControlPress>(() => {
    /** Start a new press, ending whatever an earlier one left behind. */
    const begin = (): void => { state.current = open() ? 'open' : 'dropped'; };
    return {
      begin,
      beginOnStepKey: (event) => { if (STEP_KEYS.has(event.key)) begin(); },
      change: () => {
        if (state.current === 'idle') begin();
        return state.current === 'open';
      },
      drop: () => {
        const was = state.current === 'open';
        if (was) state.current = 'dropped';
        return was;
      },
      release: () => {
        const was = state.current === 'open';
        state.current = 'idle';
        return was;
      },
    };
  }, [open]);
}

/**
 * A Slider `onValueCommit` that runs after the change it commits: on a key step Radix Slider calls `onValueCommit`
 * before `onValueChange`, so the commit waits for the change of the same event.
 * @param commit - Ends the press and writes it.
 * @returns The handler.
 */
export function commitAfterChange(commit: () => void): () => void {
  return () => { queueMicrotask(commit); };
}
