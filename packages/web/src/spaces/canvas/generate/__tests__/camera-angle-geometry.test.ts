// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the camera sits for a pose, and which pose a pointer ray picks
 * (inner#830). The card faces +z; azimuth is measured on the subject's own
 * side, so 90 — the subject's right — is -x.
 */

import { describe, expect, it } from 'vitest';

import {
  angleFromOffset,
  cameraOffset,
  pickOnSphere,
  radiusFor,
} from '@web/spaces/canvas/generate/camera-angle-geometry';

describe('cameraOffset', () => {
  it('puts the front on +z, the subject\'s right on -x, the back on -z and the left on +x', () => {
    const at = (azimuth: number) => cameraOffset(azimuth, 0, 1);
    expect(at(0).z).toBeCloseTo(1);
    expect(at(90).x).toBeCloseTo(-1);
    expect(at(180).z).toBeCloseTo(-1);
    expect(at(270).x).toBeCloseTo(1);
  });

  it('lifts the camera for a positive elevation and lowers it for a negative one', () => {
    expect(cameraOffset(0, 60, 1).y).toBeCloseTo(Math.sin(Math.PI / 3));
    expect(cameraOffset(0, -30, 1).y).toBeCloseTo(-0.5);
  });

  it('keeps the camera on a sphere of the given radius', () => {
    const { x, y, z } = cameraOffset(135, 30, 2);
    expect(Math.hypot(x, y, z)).toBeCloseTo(2);
  });
});

describe('angleFromOffset', () => {
  it('reads back the pose an offset was made from', () => {
    for (const [azimuth, elevation] of [[0, 0], [45, 30], [90, -30], [225, 60], [315, 0]] as const) {
      const back = angleFromOffset(cameraOffset(azimuth, elevation, 1.35), 1.35);
      expect(back.azimuth).toBeCloseTo(azimuth);
      expect(back.elevation).toBeCloseTo(elevation);
    }
  });

  it('holds the elevation inside -30 to 60', () => {
    expect(angleFromOffset({ x: 0, y: 1, z: 0 }, 1).elevation).toBe(60);
    expect(angleFromOffset({ x: 0, y: -1, z: 0 }, 1).elevation).toBe(-30);
  });
});

describe('pickOnSphere', () => {
  const center = { x: 0, y: 0, z: 0 };
  const down = { x: 0, y: 0, z: -1 };

  it('takes the near crossing when the camera was on the near side, and the far one when it was behind', () => {
    const origin = { x: 0, y: 0, z: 5 };
    expect(pickOnSphere(origin, down, center, 1, { x: 0, y: 0, z: 1 }).z).toBeCloseTo(1);
    expect(pickOnSphere(origin, down, center, 1, { x: 0, y: 0, z: -1 }).z).toBeCloseTo(-1);
  });

  it('takes the nearest point of the outline when the ray misses the sphere', () => {
    const point = pickOnSphere({ x: 3, y: 0, z: 5 }, down, center, 1, { x: 0, y: 0, z: 1 });
    expect(point.x).toBeCloseTo(1);
    expect(point.z).toBeCloseTo(0);
  });
});

describe('radiusFor', () => {
  it('moves the camera out one step per distance step', () => {
    expect(radiusFor(0)).toBeLessThan(radiusFor(1));
    expect(radiusFor(1)).toBeLessThan(radiusFor(2));
  });
});
