// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { DEFAULT_VIEWFINDER_RATIO, type ViewfinderRatio, type ViewfinderRect } from '@web/spaces/three-d/viewfinder/viewfinder-geometry';

/** Where the viewfinder stands (#1411 design 6.1). */
export type ViewfinderPhase = 'off' | 'framing' | 'captured' | 'picking' | 'sending';
export type ViewfinderTarget = 'agent' | 'canvas' | 'copy';

/** A captured still and where its preview is shown from. */
export interface ViewfinderShot {
  file: File;
  url: string;
  width: number;
  height: number;
}

export interface ViewfinderState {
  phase: ViewfinderPhase;
  ratio: ViewfinderRatio;
  frame: ViewfinderRect;
  shot: ViewfinderShot | null;
  sending: ViewfinderTarget | null;
  /** Changes with every capture; a send's result only touches the capture it was started from. */
  session: number;
}

/**
 * How a send ended for the capture it came from: `done` closes, `retry` goes
 * back to the shot because nothing was written, `close` ends after something
 * was placed but did not finish.
 */
export type ViewfinderOutcome = 'done' | 'retry' | 'close';

export type ViewfinderAction =
  | { type: 'open'; frame: ViewfinderRect }
  | { type: 'close' }
  | { type: 'escape' }
  | { type: 'frame'; frame: ViewfinderRect }
  | { type: 'ratio'; ratio: ViewfinderRatio; frame: ViewfinderRect }
  | { type: 'captured'; shot: ViewfinderShot }
  | { type: 'reframe' }
  | { type: 'pick' }
  | { type: 'unpick' }
  | { type: 'send'; target: ViewfinderTarget }
  | { type: 'settle'; session: number; outcome: ViewfinderOutcome };

export const INITIAL_VIEWFINDER: ViewfinderState = {
  phase: 'off',
  ratio: DEFAULT_VIEWFINDER_RATIO,
  frame: { x: 0, y: 0, width: 0, height: 0 },
  shot: null,
  sending: null,
  session: 0,
};

/**
 * Close the viewfinder, keeping the ratio and the session count.
 * @param state - The state.
 * @returns The closed state.
 */
function closed(state: ViewfinderState): ViewfinderState {
  return { ...state, phase: 'off', shot: null, sending: null };
}

/**
 * Advance the viewfinder by one user action or send result.
 * @param state - The current state.
 * @param action - What happened.
 * @returns The next state, the same object when nothing changes.
 */
export function viewfinderReducer(state: ViewfinderState, action: ViewfinderAction): ViewfinderState {
  switch (action.type) {
    case 'open':
      return state.phase === 'off' ? { ...state, phase: 'framing', frame: action.frame, shot: null, sending: null } : state;
    case 'close':
      return state.phase === 'off' ? state : closed(state);
    case 'escape':
      if (state.phase === 'captured') return { ...state, phase: 'framing', shot: null };
      if (state.phase === 'picking') return { ...state, phase: 'captured' };
      return state.phase === 'off' ? state : closed(state);
    case 'frame':
      return state.phase === 'off' ? state : { ...state, frame: action.frame };
    case 'ratio':
      return state.phase === 'framing' ? { ...state, ratio: action.ratio, frame: action.frame } : state;
    case 'captured':
      return state.phase === 'framing' ? { ...state, phase: 'captured', shot: action.shot, session: state.session + 1 } : state;
    case 'reframe':
      return state.phase === 'captured' ? { ...state, phase: 'framing', shot: null } : state;
    case 'pick':
      return state.phase === 'captured' ? { ...state, phase: 'picking' } : state;
    case 'unpick':
      return state.phase === 'picking' ? { ...state, phase: 'captured' } : state;
    case 'send': {
      const from = action.target === 'canvas' ? 'picking' : 'captured';
      return state.phase === from ? { ...state, phase: 'sending', sending: action.target } : state;
    }
    case 'settle':
      if (state.phase !== 'sending' || state.session !== action.session) return state;
      return action.outcome === 'retry' ? { ...state, phase: 'captured', sending: null } : closed(state);
  }
}
