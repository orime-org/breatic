// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { CAMERA_COMMANDS } from '@breatic/shared';
import { describe, expect, it } from 'vitest';

import {
  canPickCameraCommand,
  pickCameraCommand,
} from '@web/spaces/canvas/generate/camera-command-picks';

describe('pickCameraCommand', () => {
  it('adds a command to the end, and a second click takes it out', () => {
    expect(pickCameraCommand([], 'Push in')).toEqual(['Push in']);
    expect(pickCameraCommand(['Push in'], 'Zoom out')).toEqual(['Push in', 'Zoom out']);
    expect(pickCameraCommand(['Push in', 'Zoom out'], 'Push in')).toEqual(['Zoom out']);
  });

  it('swaps the other direction of an axis for the new one, at the end', () => {
    expect(pickCameraCommand(['Truck left', 'Push in'], 'Truck right')).toEqual(['Push in', 'Truck right']);
    expect(pickCameraCommand(['Tilt up'], 'Tilt down')).toEqual(['Tilt down']);
  });

  it('lets Static shot replace everything, and a movement replace Static shot', () => {
    expect(pickCameraCommand(['Pan left', 'Zoom in', 'Shake'], 'Static shot')).toEqual(['Static shot']);
    expect(pickCameraCommand(['Static shot'], 'Pan left')).toEqual(['Pan left']);
  });

  it('allows commands on different axes together', () => {
    expect(pickCameraCommand(['Push in'], 'Zoom out')).toEqual(['Push in', 'Zoom out']);
    expect(pickCameraCommand(['Tracking shot', 'Shake'], 'Pan left')).toEqual(['Tracking shot', 'Shake', 'Pan left']);
  });

  it('refuses a fourth command that would not replace one', () => {
    const full = ['Truck left', 'Push in', 'Zoom out'];
    expect(pickCameraCommand(full, 'Pan left')).toEqual(full);
    expect(pickCameraCommand(full, 'Truck right')).toEqual(['Push in', 'Zoom out', 'Truck right']);
  });
});

describe('canPickCameraCommand', () => {
  it('lets every command be picked while fewer than three are', () => {
    for (const command of CAMERA_COMMANDS) expect(canPickCameraCommand(['Pan left'], command), command).toBe(true);
  });

  it('at three, keeps only the picked ones, their opposites and Static shot', () => {
    const full = ['Truck left', 'Push in', 'Zoom out'];
    const pickable = CAMERA_COMMANDS.filter((command) => canPickCameraCommand(full, command));
    expect([...pickable].sort()).toEqual(
      ['Truck left', 'Truck right', 'Push in', 'Pull out', 'Zoom in', 'Zoom out', 'Static shot'].sort(),
    );
  });
});
