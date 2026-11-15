// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import * as State from '@web/spaces/three-d/viewfinder/viewfinder-state';

const { INITIAL_VIEWFINDER, viewfinderReducer } = State;
type Action = Record<string, unknown>;
type Shape = Record<string, unknown> & { phase: string; source: { kind: string; id?: string }; returnView: unknown; opening: number };

const FRAME = { x: 40, y: 60, width: 640, height: 360 };
const VIEW = { position: [6, 4, 8], target: [0, 1, 0] };
const SHOT = { file: new File(['png'], 'shot.png', { type: 'image/png' }), width: 2048, height: 1152 };
const POSE = { position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: 32, aspect: 16 / 9 };
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

/**
 * Apply actions in order through the real reducer.
 * @param actions - The actions.
 * @param from - The starting state.
 * @returns The state after the last one.
 */
function run(actions: readonly Action[], from: unknown = INITIAL_VIEWFINDER): Shape {
  return actions.reduce<unknown>((state, action) => viewfinderReducer(state as never, action as never), from) as Shape;
}

const lookA = run([{ type: 'look', id: A, view: VIEW, frame: FRAME }]);
const capturedA = run([{ type: 'captured', shot: SHOT, pose: POSE }], lookA);

describe('looking through a camera (inner#1694 design 6.1)', () => {
  it('enters camera framing from off and remembers the view to return to', () => {
    expect(lookA).toMatchObject({ phase: 'framing', source: { kind: 'camera', id: A }, returnView: VIEW });
  });

  it('switches cameras without replacing the remembered view', () => {
    const next = run([{ type: 'look', id: B, view: { position: [9, 9, 9], target: [0, 0, 0] }, frame: FRAME }], lookA);
    expect(next).toMatchObject({ phase: 'framing', source: { kind: 'camera', id: B }, returnView: VIEW });
  });

  it('counts an opening on every open and every source change', () => {
    const open = run([{ type: 'open', frame: FRAME }]);
    const reopened = run([{ type: 'close' }, { type: 'open', frame: FRAME }], open);
    expect(reopened.opening).toBeGreaterThan(open.opening);
    const switched = run([{ type: 'look', id: B, view: VIEW, frame: FRAME }], lookA);
    expect(switched.opening).toBeGreaterThan(lookA.opening);
  });

  it('closes and clears the remembered view on exit, Escape while framing, or its toolbar button', () => {
    for (const action of [{ type: 'exitCamera' }, { type: 'escape' }, { type: 'close' }]) {
      expect(run([action], lookA)).toMatchObject({ phase: 'off', source: { kind: 'free' }, returnView: null });
    }
  });

  it('keeps the still and its frozen pose after capture, and Escape returns to camera framing', () => {
    expect(capturedA).toMatchObject({ phase: 'captured', source: { kind: 'camera', id: A }, frozen: POSE });
    expect(run([{ type: 'escape' }], capturedA)).toMatchObject({ phase: 'framing', source: { kind: 'camera', id: A }, shot: null });
  });

  it('turns a deleted camera into a free still that keeps the view to return to', () => {
    const deleted = run([{ type: 'cameraDeleted', id: A }], capturedA);
    expect(deleted).toMatchObject({ phase: 'captured', source: { kind: 'free' }, returnView: VIEW, frozen: POSE });
    expect(run([{ type: 'reframe' }], deleted)).toMatchObject({ phase: 'off', returnView: null });
    expect(run([{ type: 'escape' }], deleted)).toMatchObject({ phase: 'off', returnView: null });
  });

  it('closes camera framing when its camera is deleted', () => {
    expect(run([{ type: 'cameraDeleted', id: A }], lookA)).toMatchObject({ phase: 'off', returnView: null });
  });

  it('ignores the deletion of another camera', () => {
    expect(run([{ type: 'cameraDeleted', id: B }], lookA)).toMatchObject({ phase: 'framing', source: { kind: 'camera', id: A } });
  });

  it('closes the canvas list when edit permission is lost while picking', () => {
    const picking = run([{ type: 'pick' }], capturedA);
    expect(run([{ type: 'permissionLost' }], picking)).toMatchObject({ phase: 'captured', source: { kind: 'camera', id: A } });
    const freePicking = run([{ type: 'open', frame: FRAME }, { type: 'captured', shot: SHOT }, { type: 'pick' }, { type: 'permissionLost' }]);
    expect(freePicking).toMatchObject({ phase: 'captured' });
  });
});

describe('the single camera-view value (design 3.4.3)', () => {
  const cameraViewOf = (State as unknown as { cameraViewOf: (state: unknown, camera: { locked: boolean } | null, canEdit: boolean) => unknown }).cameraViewOf;

  it('is exported', () => { expect(typeof cameraViewOf).toBe('function'); });

  it('is null when closed or framing freely', () => {
    expect(cameraViewOf(INITIAL_VIEWFINDER, null, true)).toBeNull();
    expect(cameraViewOf(run([{ type: 'open', frame: FRAME }]), null, true)).toBeNull();
  });

  it('is live while framing through a camera, with canPilot from permission and lock only', () => {
    expect(cameraViewOf(lookA, { locked: false }, true)).toEqual({ kind: 'live', id: A, canPilot: true });
    expect(cameraViewOf(lookA, { locked: true }, true)).toEqual({ kind: 'live', id: A, canPilot: false });
    expect(cameraViewOf(lookA, { locked: false }, false)).toEqual({ kind: 'live', id: A, canPilot: false });
  });

  it('is frozen after a capture from a camera and after that camera is deleted', () => {
    expect(cameraViewOf(capturedA, { locked: false }, true)).toEqual({ kind: 'frozen', id: A, ...POSE });
    expect(cameraViewOf(run([{ type: 'cameraDeleted', id: A }], capturedA), null, true)).toEqual({ kind: 'frozen', id: null, ...POSE });
  });
});
