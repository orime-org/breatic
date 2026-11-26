// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { DEFAULT_VIEWFINDER_RATIO, type ViewfinderRatio } from '@breatic/shared';

import type { ViewfinderRect } from '@web/spaces/three-d/viewfinder/viewfinder-geometry';
import type { SceneCameraView, SceneFrozenPose, SceneView } from '@web/spaces/three-d/viewport/scene-viewport-props';

/** Where the viewfinder stands (#1411 design 6.1). */
export type ViewfinderPhase = 'off' | 'framing' | 'captured' | 'picking' | 'sending';
export type ViewfinderTarget = 'agent' | 'canvas' | 'copy';

/** A captured still and its pixel size. */
export interface ViewfinderShot {
  file: File;
  width: number;
  height: number;
}

/** Where the frame looks from: the user's own view, or a camera (inner#1694 design 6.1). */
export type ViewfinderSource = { kind: 'free' } | { kind: 'camera'; id: string };

export interface ViewfinderState {
  phase: ViewfinderPhase;
  source: ViewfinderSource;
  /** The user's own view before entering a camera; set only while a camera view lasts. */
  returnView: SceneView | null;
  /** Changes on every open and every source change; a capture is kept only by the opening that started it. */
  opening: number;
  /** The main view when a camera still was taken. */
  frozen: SceneFrozenPose | null;
  /** The free frame's ratio; a camera's frame comes from its record. */
  ratio: ViewfinderRatio;
  frame: ViewfinderRect;
  shot: ViewfinderShot | null;
  sending: ViewfinderTarget | null;
  /** Changes with every capture; a send's result only touches the capture it was started from. */
  session: number;
}

/**
 * How a send ended for the capture it came from: `done` closes once the still
 * was handed over, `retry` goes back to the shot because the hand-over failed.
 */
export type ViewfinderOutcome = 'done' | 'retry';

export type ViewfinderAction =
  | { type: 'open'; frame: ViewfinderRect }
  | { type: 'look'; id: string; view: SceneView; frame: ViewfinderRect }
  | { type: 'exitCamera' }
  | { type: 'cameraDeleted'; id: string }
  | { type: 'permissionLost' }
  | { type: 'close' }
  | { type: 'escape' }
  | { type: 'frame'; frame: ViewfinderRect }
  | { type: 'ratio'; ratio: ViewfinderRatio; frame: ViewfinderRect }
  | { type: 'captured'; shot: ViewfinderShot; pose?: SceneFrozenPose }
  | { type: 'reframe' }
  | { type: 'pick' }
  | { type: 'unpick' }
  | { type: 'send'; target: ViewfinderTarget }
  | { type: 'settle'; session: number; outcome: ViewfinderOutcome };

const FREE: ViewfinderSource = { kind: 'free' };

export const INITIAL_VIEWFINDER: ViewfinderState = {
  phase: 'off',
  source: FREE,
  returnView: null,
  opening: 0,
  frozen: null,
  ratio: DEFAULT_VIEWFINDER_RATIO,
  frame: { x: 0, y: 0, width: 0, height: 0 },
  shot: null,
  sending: null,
  session: 0,
};

/**
 * Close the viewfinder, keeping the ratio and the session count; leaving a camera changes the source.
 * @param state - The state.
 * @returns The closed state.
 */
function closed(state: ViewfinderState): ViewfinderState {
  return { ...state, phase: 'off', shot: null, sending: null, frozen: null, returnView: null, source: FREE,
    opening: state.source.kind === 'camera' ? state.opening + 1 : state.opening };
}

/**
 * Whether this is a still taken through a camera that was deleted since.
 * @param state - The state.
 * @returns True when the source fell back to free while a camera view lasts.
 */
function orphanStill(state: ViewfinderState): boolean {
  return state.source.kind === 'free' && state.returnView !== null;
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
      return state.phase === 'off' ? { ...state, phase: 'framing', frame: action.frame, shot: null, sending: null, opening: state.opening + 1 } : state;
    case 'look':
      if (state.phase === 'framing' && state.source.kind === 'camera' && state.source.id === action.id) return state;
      return { ...state, phase: 'framing', source: { kind: 'camera', id: action.id }, frame: action.frame, shot: null, sending: null,
        frozen: null, returnView: state.returnView ?? action.view, opening: state.opening + 1 };
    case 'exitCamera':
      return state.phase === 'framing' && state.source.kind === 'camera' ? closed(state) : state;
    case 'cameraDeleted':
      if (state.source.kind !== 'camera' || state.source.id !== action.id) return state;
      return state.phase === 'framing' ? closed(state) : { ...state, source: FREE, opening: state.opening + 1 };
    case 'permissionLost':
      return state.phase === 'picking' ? { ...state, phase: 'captured' } : state;
    case 'close':
      return state.phase === 'off' ? state : closed(state);
    case 'escape':
      if (state.phase === 'captured') return orphanStill(state) ? closed(state) : { ...state, phase: 'framing', shot: null, frozen: null };
      if (state.phase === 'picking') return { ...state, phase: 'captured' };
      return state.phase === 'off' ? state : closed(state);
    case 'frame':
      return state.phase === 'off' ? state : { ...state, frame: action.frame };
    case 'ratio':
      return state.phase === 'framing' ? { ...state, ratio: action.ratio, frame: action.frame } : state;
    case 'captured':
      return state.phase === 'framing' ? { ...state, phase: 'captured', shot: action.shot, frozen: action.pose ?? null, session: state.session + 1 } : state;
    case 'reframe':
      if (state.phase !== 'captured') return state;
      return orphanStill(state) ? closed(state) : { ...state, phase: 'framing', shot: null, frozen: null };
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

/**
 * The one value that says what the main view shows (design 3.4.3).
 * @param state - The viewfinder state.
 * @param camera - The source camera's record, when the source is a camera that still exists.
 * @param camera.locked - Whether it is locked.
 * @param canEdit - Whether this user may edit the scene now.
 * @returns Null for the user's own view, `live` while framing through a camera, `frozen` for a still taken through one.
 */
export function cameraViewOf(state: ViewfinderState, camera: { locked: boolean } | null, canEdit: boolean): SceneCameraView | null {
  if (state.phase === 'framing' && state.source.kind === 'camera') {
    return { kind: 'live', id: state.source.id, canPilot: canEdit && camera !== null && !camera.locked };
  }
  if (state.phase !== 'off' && state.phase !== 'framing' && state.frozen !== null) {
    return { kind: 'frozen', id: state.source.kind === 'camera' ? state.source.id : null, ...state.frozen };
  }
  return null;
}
