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


/** What the pilot needs from the viewport it drives. */
export interface PilotHost {
  readonly canvas: HTMLCanvasElement;
  /** Whether a camera view is shown, live or still; the browser menu and page scroll stay off throughout. */
  active(): boolean;
  /** The camera being looked through, or null when the view is not a live camera view. */
  live(): { id: string; canPilot: boolean; locked: boolean } | null;
  /** That camera's committed pose. */
  recordPose(): PilotPose | null;
  /** Whether a handle, joint or object gesture has taken the current press. */
  objectGesture(): boolean;
  /** The centre of the models' bounding box, or null when there is no model. */
  modelBoxCentre(): Vector3 | null;
  /** The main view's height in pixels and vertical field of view in radians. */
  viewSize(): { height: number; fov: number };
  /** How long a wheel pause lasts before it is written, once configured. */
  wheelCommitMs(): number | undefined;
  /** Show the current draft, or the record when there is none. */
  show(): void;
  preview(id: string, pose: PilotPose): void;
  end(commit: boolean): void;
  notifyLocked(): void;
}

/**
 * The only thing that moves the main camera during a live camera view, and the only writer of its draft
 * (inner#1694 design 3.4.1): it turns pointer and wheel input into pilot events and runs their effects.
 * @throws {never} Never.
 */
export class ScenePilot {
  private state: PilotState = PILOT_IDLE;
  private draft: { id: string; pose: PilotPose; pivotDistance: number } | null = null;
  private origin: { x: number; y: number; id: number; pan: boolean } | null = null;
  private last: { x: number; y: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Listen on the viewport canvas.
   * @param host - The viewport.
   */
  constructor(private readonly host: PilotHost) {
    const { canvas } = host;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('lostpointercapture', this.onPointerCancel);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /**
   * The draft pose of a camera, while one is being piloted.
   * @param id - The camera.
   * @returns Its draft pose, or null.
   */
  poseOf(id: string): PilotPose | null {
    return this.draft?.id === id ? this.draft.pose : null;
  }

  /**
   * Feed one event and run what it calls for.
   * @param event - The event.
   */
  dispatch(event: PilotEvent): void {
    const before = this.state;
    // A wheel step taken while the button was down is written at the threshold; the drag goes on from where it left the camera.
    const carried = this.draft;
    const { state, effects } = pilotStep(before, event);
    this.state = state;
    if (before.wheel === 'pending' && state.wheel === 'idle') this.stopTimer();
    for (const effect of effects) {
      if (effect === 'lockedNotice') this.host.notifyLocked();
      else this.finish(effect === 'commit');
    }
    if (event.type === 'move' && before.pointer === 'held' && state.pointer === 'dragging') this.begin(carried);
  }

  /**
   * Write a pending wheel step and drop a drag, before undo, redo or a viewfinder change.
   * @param reason - What is about to happen.
   */
  flush(reason: 'exit' | 'switch' | 'confirm' | 'undo' | 'blur' | 'hide' = 'undo'): void {
    this.dispatch({ type: reason });
  }

  /**
   * Escape: drop a press in progress, or write a pending wheel step.
   * @returns True when a press was in progress.
   */
  escape(): boolean {
    const pressed = this.state.pointer === 'held' || this.state.pointer === 'dragging';
    this.dispatch({ type: 'escape' });
    return pressed;
  }

  /**
   * End a draft through one of the two outlets.
   * @param commit - Write it, or drop it.
   */
  private finish(commit: boolean): void {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    this.host.end(commit);
    this.host.show();
  }

  /**
   * Begin a draft at the record's pose with this gesture's pivot, or where a just-written draft left the camera.
   * @param from - The draft just written, whose pose the record has not caught up with yet.
   * @returns The draft, or null without a live camera.
   */
  private begin(from: { id: string; pose: PilotPose; pivotDistance: number } | null = null): { id: string; pose: PilotPose; pivotDistance: number } | null {
    if (this.draft) return this.draft;
    const live = this.host.live();
    if (from && live?.id === from.id) {
      this.draft = { id: from.id, pose: { position: from.pose.position.clone(), quaternion: from.pose.quaternion.clone() }, pivotDistance: from.pivotDistance };
      return this.draft;
    }
    const record = this.host.recordPose();
    if (!live || !record) return null;
    const pose = { position: record.position.clone(), quaternion: record.quaternion.clone() };
    this.draft = { id: live.id, pose, pivotDistance: pilotPivotDistance(pose.position, this.host.modelBoxCentre()) };
    return this.draft;
  }

  /**
   * Publish a new draft pose.
   * @param pose - The pose.
   */
  private move(pose: PilotPose): void {
    if (!this.draft) return;
    this.draft.pose = pose;
    this.host.preview(this.draft.id, pose);
    this.host.show();
  }

  /**
   * Start a press on the live camera view.
   * @param event - The press.
   */
  private onDown = (event: PointerEvent): void => {
    if (!this.host.live() || (event.button !== 0 && event.button !== 2)) return;
    this.origin = { x: event.clientX, y: event.clientY, id: event.pointerId, pan: event.button === 2 || event.shiftKey };
    this.last = { x: event.clientX, y: event.clientY };
    // With orbiting off nothing else holds the pointer, and a release over the panel or menu would never reach the canvas.
    this.host.canvas.setPointerCapture(event.pointerId);
    this.dispatch({ type: 'down' });
  };

  /**
   * Decide the press at the drag threshold, then turn or slide the camera.
   * @param event - The move.
   */
  private onMove = (event: PointerEvent): void => {
    const origin = this.origin;
    const live = this.host.live();
    if (!origin || event.pointerId !== origin.id || !live) return;
    // A release the canvas never heard of: no button is down any more.
    if ((event.buttons & 3) === 0) { this.onUp(event); return; }
    if (this.state.pointer === 'held') {
      this.dispatch({ type: 'move', distance: Math.hypot(event.clientX - origin.x, event.clientY - origin.y),
        objectGesture: this.host.objectGesture(), canPilot: live.canPilot, locked: live.locked });
    }
    if (this.state.pointer !== 'dragging' || !this.draft || !this.last) return;
    const dx = event.clientX - this.last.x;
    const dy = event.clientY - this.last.y;
    this.last = { x: event.clientX, y: event.clientY };
    const { height, fov } = this.host.viewSize();
    if (height === 0) return;
    const { pose, pivotDistance } = this.draft;
    // OrbitControls' convention: a drag across the view height turns a full circle; a pan follows the pointer.
    this.move(origin.pan ? panPilot(pose, pivotDistance, dx * fov / height, dy * fov / height)
      : orbitPilot(pose, pivotDistance, 2 * Math.PI * dx / height, 2 * Math.PI * dy / height));
  };

  /**
   * End the press.
   * @param event - The release.
   */
  private onUp = (event: PointerEvent): void => {
    if (!this.origin || event.pointerId !== this.origin.id) return;
    this.origin = null;
    this.last = null;
    this.dispatch({ type: 'up' });
  };

  /**
   * Drop a press the browser took away.
   * @param event - The cancellation.
   */
  private onPointerCancel = (event: PointerEvent): void => {
    if (!this.origin || event.pointerId !== this.origin.id) return;
    this.dispatch({ type: 'escape' });
    this.onUp(event);
  };

  /**
   * Dolly the camera; the page never scrolls during a camera view.
   * @param event - The wheel step.
   */
  private onWheel = (event: WheelEvent): void => {
    if (this.host.active()) event.preventDefault();
    const live = this.host.live();
    if (!live) return;
    this.dispatch({ type: 'wheel', canPilot: live.canPilot });
    if (!live.canPilot || (this.state.wheel !== 'pending' && this.state.pointer !== 'dragging')) return;
    const draft = this.begin();
    if (!draft) return;
    // One notch of a mouse wheel is 100 pixels of deltaY in Chromium, Firefox and Safari.
    const moved = dollyPilot(draft.pose, draft.pivotDistance, -event.deltaY / 100);
    draft.pivotDistance = moved.pivotDistance;
    this.move(moved.pose);
    if (this.state.wheel === 'pending') this.startTimer();
  };

  /**
   * Keep the browser menu away from a right drag during a camera view.
   * @param event - The menu request.
   */
  private onContextMenu = (event: MouseEvent): void => {
    if (this.host.active()) event.preventDefault();
  };

  /** Restart the wheel pause. */
  private startTimer(): void {
    this.stopTimer();
    const delay = this.host.wheelCommitMs();
    if (delay === undefined) return;
    this.timer = setTimeout(() => { this.timer = null; this.dispatch({ type: 'pause' }); }, delay);
  }

  /** Stop the wheel pause. */
  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Stop listening; a draft still open is dropped. */
  dispose(): void {
    this.stopTimer();
    this.finish(false);
    const { canvas } = this.host;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('lostpointercapture', this.onPointerCancel);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
