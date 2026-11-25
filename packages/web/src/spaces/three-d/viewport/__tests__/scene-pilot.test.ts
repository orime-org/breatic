// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

type Effect = 'commit' | 'cancel' | 'lockedNotice';
interface PilotState { pointer: 'idle' | 'held' | 'dragging' | 'dropped'; wheel: 'idle' | 'pending' }
interface Pose { position: Vector3; quaternion: Quaternion }
type Step = (state: PilotState, event: Record<string, unknown>) => { state: PilotState; effects: readonly Effect[] };

const modules = import.meta.glob<Record<string, unknown>>('../scene-pilot.ts', { eager: true });
const pilot = modules['../scene-pilot.ts'] ?? {};
const step = pilot.pilotStep as Step;
const IDLE: PilotState = { pointer: 'idle', wheel: 'idle' };
const FREE = { canPilot: true, locked: false };

/**
 * Run events in order through the real step function.
 * @param events - The events.
 * @param from - The starting state.
 * @returns The final state and every effect in order.
 */
function run(events: readonly Record<string, unknown>[], from: PilotState = IDLE): { state: PilotState; effects: Effect[] } {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) {
    const out = step(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const DOWN = { type: 'down' };
const CROSS = { type: 'move', distance: 5, objectGesture: false, ...FREE };
const WHEEL = { type: 'wheel', ...FREE };

describe('ScenePilot events (inner#1694 design 6.2)', () => {
  it('exports the step function', () => { expect(typeof step).toBe('function'); });

  it('a click that stays within 4 px writes nothing', () => {
    expect(run([DOWN, { ...CROSS, distance: 3 }, { type: 'up' }])).toEqual({ state: IDLE, effects: [] });
  });

  it('a drag past 4 px writes once on release', () => {
    expect(run([DOWN, CROSS, { ...CROSS, distance: 40 }, { type: 'up' }])).toEqual({ state: IDLE, effects: ['commit'] });
  });

  it('a press a handle, a joint or an object gesture has taken belongs to object operations', () => {
    expect(run([DOWN, { ...CROSS, objectGesture: true }, { ...CROSS, distance: 40 }, { type: 'up' }]).effects).toEqual([]);
  });

  it('a locked camera is told once at the threshold and never on a click', () => {
    const locked = { canPilot: false, locked: true };
    expect(run([DOWN, { type: 'up' }]).effects).toEqual([]);
    expect(run([DOWN, { ...CROSS, ...locked }, { ...CROSS, ...locked, distance: 30 }, { type: 'up' }]).effects).toEqual(['lockedNotice']);
  });

  it('a Viewer drag neither moves the camera nor shows the lock notice', () => {
    expect(run([DOWN, { ...CROSS, canPilot: false, locked: false }, { type: 'up' }]).effects).toEqual([]);
  });

  it('a wheel step without pilot permission starts no pause', () => {
    expect(run([{ ...WHEEL, canPilot: false }])).toEqual({ state: IDLE, effects: [] });
  });

  it('a wheel step writes when the pause ends, and any press writes a pending pause first', () => {
    expect(run([WHEEL, WHEEL, { type: 'pause' }])).toEqual({ state: IDLE, effects: ['commit'] });
    expect(run([WHEEL, DOWN])).toEqual({ state: { pointer: 'held', wheel: 'idle' }, effects: ['commit'] });
  });

  it('crossing the threshold with a pause pending writes the pause first, so two drafts never coexist', () => {
    expect(run([DOWN, WHEEL, CROSS])).toEqual({ state: { pointer: 'dragging', wheel: 'idle' }, effects: ['commit'] });
  });

  it('a wheel step during a drag joins the drag and starts no pause', () => {
    expect(run([DOWN, CROSS, WHEEL, { type: 'up' }])).toEqual({ state: IDLE, effects: ['commit'] });
  });

  it.each(['exit', 'switch', 'confirm', 'undo', 'blur', 'hide'])('%s writes a pending pause and drops a drag', (type) => {
    expect(run([WHEEL, { type }])).toEqual({ state: IDLE, effects: ['commit'] });
    const dragged = run([DOWN, CROSS, { type }, { ...CROSS, distance: 30 }, { type: 'up' }]);
    expect(dragged).toEqual({ state: IDLE, effects: ['cancel'] });
  });

  it('Escape while the pointer is down drops the gesture, and the rest of the press is ignored', () => {
    expect(run([DOWN, CROSS, { type: 'escape' }, { ...CROSS, distance: 30 }, { type: 'up' }])).toEqual({ state: IDLE, effects: ['cancel'] });
    expect(run([DOWN, { type: 'escape' }, CROSS, { type: 'up' }])).toEqual({ state: IDLE, effects: ['cancel'] });
  });

  it('Escape with the pointer up writes a pending pause', () => {
    expect(run([WHEEL, { type: 'escape' }])).toEqual({ state: IDLE, effects: ['commit'] });
  });

  it.each(['locked', 'deleted', 'permissionLost'])('%s discards without writing', (type) => {
    expect(run([WHEEL, { type }])).toEqual({ state: IDLE, effects: ['cancel'] });
    expect(run([DOWN, CROSS, { type }, { ...CROSS, distance: 30 }, { type: 'up' }])).toEqual({ state: IDLE, effects: ['cancel'] });
  });

  it('a record change from elsewhere writes a pending pause first and leaves a drag running', () => {
    expect(run([WHEEL, { type: 'recordChanged' }])).toEqual({ state: IDLE, effects: ['commit'] });
    expect(run([DOWN, CROSS, { type: 'recordChanged' }, { type: 'up' }])).toEqual({ state: IDLE, effects: ['commit'] });
  });
});

describe('camera moves (design 3.4 item 3)', () => {
  const orbit = pilot.orbitPilot as (pose: Pose, pivotDistance: number, dx: number, dy: number) => Pose;
  const pan = pilot.panPilot as (pose: Pose, pivotDistance: number, dx: number, dy: number) => Pose;
  const dolly = pilot.dollyPilot as (pose: Pose, pivotDistance: number, steps: number) => { pose: Pose; pivotDistance: number };
  const start = (): Pose => ({ position: new Vector3(3, 2, 5), quaternion: new Quaternion(0.1, 0.3, 0.2, 0.92).normalize() });
  const forward = (pose: Pose): Vector3 => new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
  const rightRise = (q: Quaternion): number => new Vector3(1, 0, 0).applyQuaternion(q).y;

  it('exports the three moves', () => {
    expect([typeof orbit, typeof pan, typeof dolly]).toEqual(['function', 'function', 'function']);
  });

  it('keeps the roll after many random orbits and returns to the start when dragged back', () => {
    let pose = start();
    for (let i = 0; i < 200; i += 1) pose = orbit(pose, 4, Math.sin(i) * 30, Math.cos(i * 1.7) * 20);
    expect(rightRise(pose.quaternion)).toBeCloseTo(rightRise(start().quaternion), 9);
    const back = orbit(orbit(start(), 4, 40, 25), 4, -40, -25);
    expect(back.position.distanceTo(start().position)).toBeLessThan(1e-6);
  });

  it('orbits about a pivot that stays in front of the lens', () => {
    const before = start();
    const pivot = before.position.clone().addScaledVector(forward(before), 4);
    const after = orbit(before, 4, 35, -12);
    expect(after.position.distanceTo(pivot)).toBeCloseTo(4, 9);
    expect(after.position.clone().addScaledVector(forward(after), 4).distanceTo(pivot)).toBeLessThan(1e-9);
  });

  it('pans in the camera plane without turning it', () => {
    const before = start();
    const after = pan(before, 4, 30, -20);
    expect(after.quaternion.toArray()).toEqual(before.quaternion.toArray());
    expect(Math.abs(after.position.clone().sub(before.position).dot(forward(before)))).toBeLessThan(1e-9);
    expect(after.position.distanceTo(before.position)).toBeGreaterThan(0);
  });

  it('dollies toward the pivot and never past 0.1 in front of it', () => {
    let state = { pose: start(), pivotDistance: 4 };
    const pivot = state.pose.position.clone().addScaledVector(forward(state.pose), 4);
    for (let i = 0; i < 500; i += 1) state = dolly(state.pose, state.pivotDistance, 1);
    expect(state.pose.position.distanceTo(pivot)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(state.pivotDistance).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(state.pose.quaternion.toArray()).toEqual(start().quaternion.toArray());
  });

  it('places the pivot at the larger of the distance to the model box centre and 2 units', () => {
    const distance = pilot.pilotPivotDistance as (position: Vector3, modelBoxCentre: Vector3 | null) => number;
    expect(typeof distance).toBe('function');
    expect(distance(new Vector3(0, 0, 10), new Vector3(0, 0, 0))).toBe(10);
    expect(distance(new Vector3(0, 0, 1), new Vector3(0, 0, 0))).toBe(2);
    expect(distance(new Vector3(0, 0, 10), null)).toBe(2);
  });

});
