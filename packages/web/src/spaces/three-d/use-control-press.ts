// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/** One press of a continuous control (a slider drag, a colour pick). */
export interface ControlPress {
  /**
   * Take a change of the control.
   * @param start - Opens the drag on the press's first change; false when it cannot open.
   * @returns Whether the change belongs to an open drag.
   */
  change: (start: () => boolean) => boolean;
  /** End the drag without writing it; the rest of the press is ignored until release. */
  drop: () => void;
  /**
   * End the press.
   * @returns Whether its drag was still open, so the release writes it.
   */
  release: () => boolean;
}

/**
 * Track one press of a continuous control: once Escape, a lock or an undo ends its drag, every later change of the same
 * press is ignored until release (design 3.8 and 6.2, the same rule the camera pilot follows).
 * @returns The press.
 */
export function useControlPress(): ControlPress {
  const state = React.useRef<'idle' | 'open' | 'dropped'>('idle');
  return React.useMemo<ControlPress>(() => ({
    change: (start) => {
      if (state.current === 'idle') state.current = start() ? 'open' : 'dropped';
      return state.current === 'open';
    },
    drop: () => { if (state.current === 'open') state.current = 'dropped'; },
    release: () => {
      const open = state.current === 'open';
      state.current = 'idle';
      return open;
    },
  }), []);
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
