// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Quaternion, Vector3 } from 'three';

/** How far a press moves before it counts as a drag, in pixels. */
export const PILOT_DRAG_THRESHOLD_PX = 4;
/** The nearest a dolly comes to the pivot, in scene units. */
const PILOT_NEAREST = 0.1;
/** The shortest pivot distance, in scene units, also used when the scene has no model. */
const PILOT_MIN_PIVOT = 2;
/** How much of the distance to the pivot one wheel step keeps. */
const DOLLY_STEP = 0.9;

/**
 * The pointer and the wheel are two independent facts (inner#1694 design 6.2); a draft exists
 * while the pointer drags or the wheel pauses.
 */
export interface PilotState {
  pointer: 'idle' | 'held' | 'dragging' | 'dropped';
  wheel: 'idle' | 'pending';
}

/** What the controller does after a step: write the draft, drop it, or tell the user the camera is locked. */
export type PilotEffect = 'commit' | 'cancel' | 'lockedNotice';

/** Events that flush a pending wheel step and drop a drag. */
const FLUSHES = new Set(['exit', 'switch', 'confirm', 'undo', 'blur', 'hide']);
/** Events that drop every draft without writing. */
const DISCARDS = new Set(['locked', 'deleted', 'permissionLost']);

export type PilotEvent =
  | { type: 'down' }
  | { type: 'move'; distance: number; objectGesture: boolean; canPilot: boolean; locked: boolean }
  | { type: 'up' }
  | { type: 'wheel'; canPilot: boolean }
  | { type: 'pause' }
  | { type: 'recordChanged' }
  | { type: 'escape' }
  | { type: 'exit' | 'switch' | 'confirm' | 'undo' | 'blur' | 'hide' }
  | { type: 'locked' | 'deleted' | 'permissionLost' };

export const PILOT_IDLE: PilotState = { pointer: 'idle', wheel: 'idle' };

/**
 * Advance the pilot by one event (design 6.2).
 * @param state - The current facts.
 * @param event - What happened.
 * @returns The next facts and what to do, in order.
 */
export function pilotStep(state: PilotState, event: PilotEvent): { state: PilotState; effects: readonly PilotEffect[] } {
  const pending = state.wheel === 'pending';
  const pressed = state.pointer === 'held' || state.pointer === 'dragging';
  switch (event.type) {
    case 'down':
      return { state: { pointer: state.pointer === 'idle' ? 'held' : state.pointer, wheel: 'idle' }, effects: pending ? ['commit'] : [] };
    case 'move': {
      if (state.pointer !== 'held' || event.distance <= PILOT_DRAG_THRESHOLD_PX) return { state, effects: [] };
      const effects: PilotEffect[] = pending ? ['commit'] : [];
      if (event.objectGesture) return { state: { pointer: 'idle', wheel: 'idle' }, effects };
      if (!event.canPilot) return { state: { pointer: 'dropped', wheel: 'idle' }, effects: event.locked ? [...effects, 'lockedNotice'] : effects };
      return { state: { pointer: 'dragging', wheel: 'idle' }, effects };
    }
    case 'up':
      return { state: { ...state, pointer: 'idle' }, effects: state.pointer === 'dragging' ? ['commit'] : [] };
    case 'wheel':
      if (!event.canPilot || state.pointer === 'dragging') return { state, effects: [] };
      return { state: { ...state, wheel: 'pending' }, effects: [] };
    case 'pause':
      return { state: { ...state, wheel: 'idle' }, effects: pending && state.pointer !== 'dragging' ? ['commit'] : [] };
    case 'recordChanged':
      return { state: { ...state, wheel: 'idle' }, effects: pending ? ['commit'] : [] };
    case 'escape':
      if (pressed) return { state: { pointer: 'dropped', wheel: 'idle' }, effects: ['cancel'] };
      return { state: { ...state, wheel: 'idle' }, effects: pending ? ['commit'] : [] };
    default:
      if (FLUSHES.has(event.type)) {
        if (state.pointer === 'dragging') return { state: { pointer: 'dropped', wheel: 'idle' }, effects: ['cancel'] };
        return { state: { ...state, wheel: 'idle' }, effects: pending ? ['commit'] : [] };
      }
      if (DISCARDS.has(event.type)) {
        return { state: { pointer: pressed ? 'dropped' : state.pointer, wheel: 'idle' }, effects: pressed || pending ? ['cancel'] : [] };
      }
      return { state, effects: [] };
  }
}

/** A camera pose the pilot moves. */
export interface PilotPose {
  position: Vector3;
  quaternion: Quaternion;
}

const UP = new Vector3(0, 1, 0);

/**
 * The point the camera turns about: straight ahead at the pivot distance.
 * @param pose - The camera pose.
 * @param pivotDistance - How far ahead the pivot is.
 * @returns The pivot.
 */
function pivotOf(pose: PilotPose, pivotDistance: number): Vector3 {
  return pose.position.clone().addScaledVector(new Vector3(0, 0, -1).applyQuaternion(pose.quaternion), pivotDistance);
}

/**
 * Turn the camera about its pivot like a turntable: yaw about world up, then pitch about the camera's own right axis,
 * which keeps its roll (DD section 8).
 * @param pose - The camera pose.
 * @param pivotDistance - How far ahead the pivot is.
 * @param yaw - Turn about world up, in radians.
 * @param pitch - Turn about the camera's right axis, in radians.
 * @returns The new pose.
 */
export function orbitPilot(pose: PilotPose, pivotDistance: number, yaw: number, pitch: number): PilotPose {
  const pivot = pivotOf(pose, pivotDistance);
  const turnYaw = new Quaternion().setFromAxisAngle(UP, -yaw);
  const yawed = turnYaw.clone().multiply(pose.quaternion);
  const right = new Vector3(1, 0, 0).applyQuaternion(yawed);
  const turnPitch = new Quaternion().setFromAxisAngle(right, -pitch);
  const turn = turnPitch.multiply(turnYaw);
  return {
    position: pose.position.clone().sub(pivot).applyQuaternion(turn).add(pivot),
    quaternion: turn.multiply(pose.quaternion).normalize(),
  };
}

/**
 * Slide the camera across its own image plane; the amounts are angles as seen from the camera.
 * @param pose - The camera pose.
 * @param pivotDistance - How far ahead the pivot is, which scales the slide.
 * @param dx - Sideways, in radians; positive moves the scene right.
 * @param dy - Up and down, in radians; positive moves the scene down.
 * @returns The new pose.
 */
export function panPilot(pose: PilotPose, pivotDistance: number, dx: number, dy: number): PilotPose {
  const right = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
  return {
    position: pose.position.clone().addScaledVector(right, -dx * pivotDistance).addScaledVector(up, dy * pivotDistance),
    quaternion: pose.quaternion.clone(),
  };
}

/**
 * Move along the lens toward the pivot by a share of the distance, never closer than 0.1 to it.
 * @param pose - The camera pose.
 * @param pivotDistance - How far ahead the pivot is.
 * @param steps - Wheel steps; positive moves in, negative moves out.
 * @returns The new pose and its distance to the same pivot.
 */
export function dollyPilot(pose: PilotPose, pivotDistance: number, steps: number): { pose: PilotPose; pivotDistance: number } {
  const pivot = pivotOf(pose, pivotDistance);
  const next = Math.max(pivotDistance * DOLLY_STEP ** steps, PILOT_NEAREST);
  const back = new Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
  return { pose: { position: pivot.addScaledVector(back, next), quaternion: pose.quaternion.clone() }, pivotDistance: next };
}

/**
 * How far ahead a gesture's pivot sits: the distance to the models' box centre, at least 2 units.
 * @param position - The camera position.
 * @param modelBoxCentre - The centre of the models' bounding box, or null when there is no model.
 * @returns The pivot distance.
 */
export function pilotPivotDistance(position: Vector3, modelBoxCentre: Vector3 | null): number {
  return modelBoxCentre === null ? PILOT_MIN_PIVOT : Math.max(position.distanceTo(modelBoxCentre), PILOT_MIN_PIVOT);
}

/**
 * Whether a pose differs from the record enough to write (design 3.4.1).
 * @param a - One pose.
 * @param b - The other.
 * @returns True past 1e-5 of position or a rotation whose quaternion dot is below 1 − 1e-9.
 */
export function pilotPoseChanged(a: PilotPose, b: PilotPose): boolean {
  return a.position.distanceTo(b.position) > 1e-5 || Math.abs(a.quaternion.dot(b.quaternion)) < 1 - 1e-9;
}
