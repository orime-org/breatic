// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The geometry behind the camera-angle sphere (inner#830), apart from
 * three.js so it can be tested on its own.
 *
 * The subject's card faces +z. Azimuth is measured on the subject's own side
 * — 90 is the subject's right, which is -x for a card facing +z — because that
 * is the side the model turns to (verified on real runs, design §2).
 *
 * Imported only by the sphere, so it travels in the sphere's own chunk.
 */

import { CAMERA_ANGLE_GRID } from '@breatic/shared';

/** A point or direction in the scene. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The lowest and highest elevation the grid holds, in degrees. */
export const ELEVATION_RANGE = [
  CAMERA_ANGLE_GRID.elevation[0],
  CAMERA_ANGLE_GRID.elevation[CAMERA_ANGLE_GRID.elevation.length - 1],
] as const;

/** The azimuths the grid holds, in degrees, one tick each on the ring. */
export const AZIMUTH_STEPS: readonly number[] = CAMERA_ANGLE_GRID.azimuth;

/** How far the camera sits from the card at each distance step. */
const RADII = [1.0, 1.35, 1.75] as const;

/**
 * The camera's distance from the card for a distance step, eased between steps.
 * @param distance - 0 close-up, 1 medium, 2 wide; fractions in between.
 * @returns The radius in scene units.
 */
export function radiusFor(distance: number): number {
  const d = Math.min(RADII.length - 1, Math.max(0, distance));
  const low = Math.floor(d);
  const high = Math.min(RADII.length - 1, low + 1);
  const from = RADII[low] ?? RADII[0];
  const to = RADII[high] ?? from;
  return from + (to - from) * (d - low);
}

/**
 * Where the camera sits relative to the card's centre.
 * @param azimuth - Degrees round the subject, 90 its right.
 * @param elevation - Degrees above (positive) or below the card.
 * @param radius - The distance from the card.
 * @returns The offset.
 */
export function cameraOffset(azimuth: number, elevation: number, radius: number): Vec3 {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return { x: -Math.sin(a) * Math.cos(e) * radius, y: Math.sin(e) * radius, z: Math.cos(a) * Math.cos(e) * radius };
}

/**
 * The pose of a camera at an offset from the card's centre.
 * @param offset - Where it sits.
 * @param radius - The sphere it sits on.
 * @returns Its azimuth in [0, 360) and its elevation held inside the grid's range.
 */
export function angleFromOffset(offset: Vec3, radius: number): { azimuth: number; elevation: number } {
  const azimuth = ((Math.atan2(-offset.x, offset.z) * 180) / Math.PI + 360) % 360;
  const sine = Math.max(-1, Math.min(1, offset.y / radius));
  const elevation = Math.max(ELEVATION_RANGE[0], Math.min(ELEVATION_RANGE[1], (Math.asin(sine) * 180) / Math.PI));
  return { azimuth, elevation };
}

/**
 * The point of a sphere under a pointer ray.
 *
 * A ray crossing the sphere meets it twice; the crossing nearer where the
 * camera already is wins, so dragging past the outline carries the camera
 * round to the far side. A ray that misses takes the outline's nearest point.
 * @param origin - Where the ray starts.
 * @param direction - Its direction, of unit length.
 * @param center - The sphere's centre.
 * @param radius - Its radius.
 * @param previous - Where the camera was, in the same space.
 * @returns The picked point.
 */
export function pickOnSphere(origin: Vec3, direction: Vec3, center: Vec3, radius: number, previous: Vec3): Vec3 {
  const oc = { x: origin.x - center.x, y: origin.y - center.y, z: origin.z - center.z };
  const b = direction.x * oc.x + direction.y * oc.y + direction.z * oc.z;
  const disc = b * b - (oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - radius * radius);
  /**
   * The point a distance along the ray.
   * @param t - The distance.
   * @returns The point.
   */
  const along = (t: number): Vec3 => ({
    x: origin.x + direction.x * t,
    y: origin.y + direction.y * t,
    z: origin.z + direction.z * t,
  });
  if (disc >= 0) {
    const s = Math.sqrt(disc);
    const near = along(-b - s);
    const far = along(-b + s);
    /**
     * Squared distance to where the camera was.
     * @param p - A point.
     * @returns The squared distance.
     */
    const gap = (p: Vec3): number => (p.x - previous.x) ** 2 + (p.y - previous.y) ** 2 + (p.z - previous.z) ** 2;
    return gap(near) <= gap(far) ? near : far;
  }
  const closest = along(-b);
  const v = { x: closest.x - center.x, y: closest.y - center.y, z: closest.z - center.z };
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: center.x + (v.x / len) * radius, y: center.y + (v.y / len) * radius, z: center.z + (v.z / len) * radius };
}
