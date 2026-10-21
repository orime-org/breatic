// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The camera poses Qwen Image Multiple Angles is trained on: 8 azimuths, 4
 * elevations and 3 distances. WaveSpeed rounds any angle it is sent to the
 * nearest of these (wavespeed.ai/docs/docs-api/wavespeed-ai/qwen-image-edit-multiple-angles),
 * so a value off the grid shows the reader a pose the model never makes.
 *
 * Azimuth is measured on the subject's own side: 90 is the subject's right.
 */

/** Every value each axis of a sphere can hold, ascending. */
export interface AngleGrid {
  readonly azimuth: readonly number[];
  readonly elevation: readonly number[];
  readonly distance: readonly number[];
}

/** Every value each axis can hold, ascending. */
export const CAMERA_ANGLE_GRID = {
  azimuth: [0, 45, 90, 135, 180, 225, 270, 315],
  elevation: [-30, 0, 30, 60],
  distance: [0, 1, 2],
} as const satisfies AngleGrid;

/** One of the three axes a pose is set along. */
export type CameraAngleAxis = keyof AngleGrid;

/** The three axes, in the order they are named and drawn. */
export const CAMERA_ANGLE_AXES: readonly CameraAngleAxis[] = ['azimuth', 'elevation', 'distance'];

/** A camera pose, one value per axis. */
export interface CameraAngle {
  azimuth: number;
  elevation: number;
  distance: number;
}

/** The pose a model's params default to: the front, at eye level, at the medium distance. */
export const DEFAULT_CAMERA_ANGLE: CameraAngle = { azimuth: 0, elevation: 0, distance: 1 };

/**
 * Where the relight tool's light can sit (inner#1304): the camera's eight
 * azimuths, heights up to straight overhead, and one distance, since a light
 * has none to set.
 */
export const LIGHT_ANGLE_GRID: AngleGrid = {
  azimuth: CAMERA_ANGLE_GRID.azimuth,
  elevation: [-30, 0, 30, 60, 90],
  distance: [1],
};

/** The two axes a light is set along. */
export const LIGHT_ANGLE_AXES: readonly CameraAngleAxis[] = ['azimuth', 'elevation'];

/** Where the light starts: the front left, above. */
export const DEFAULT_LIGHT_ANGLE: CameraAngle = { azimuth: 315, elevation: 30, distance: 1 };

/**
 * The grid value nearest a number; a tie goes to the lower one.
 * @param values - The axis's values, ascending.
 * @param x - The number to place.
 * @returns The nearest value.
 */
function nearest(values: readonly number[], x: number): number {
  return values.reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best));
}

/**
 * The grid pose nearest a pose anywhere on or off the sphere.
 * @param pose - Any azimuth (wrapped round 360), elevation and distance.
 * @param grid - The grid to snap to; the camera's when absent.
 * @returns The pose the upstream would round it to.
 */
export function nearestCameraAngle(pose: CameraAngle, grid: AngleGrid = CAMERA_ANGLE_GRID): CameraAngle {
  const wrapped = ((pose.azimuth % 360) + 360) % 360;
  const azimuth = nearest([...grid.azimuth, 360], wrapped) % 360;
  return {
    azimuth,
    elevation: nearest(grid.elevation, pose.elevation),
    distance: nearest(grid.distance, pose.distance),
  };
}

/**
 * The pose one grid step along an axis: the azimuth goes round the circle,
 * the elevation and the distance stop at their ends.
 * @param pose - A pose on the grid.
 * @param axis - The axis to step along.
 * @param delta - +1 for the next value up, -1 for the next value down.
 * @param grid - The grid to step on; the camera's when absent.
 * @returns The stepped pose.
 */
export function stepCameraAngle(
  pose: CameraAngle,
  axis: CameraAngleAxis,
  delta: 1 | -1,
  grid: AngleGrid = CAMERA_ANGLE_GRID,
): CameraAngle {
  const values = grid[axis];
  const at = values.indexOf(nearest(values, pose[axis]));
  const next =
    axis === "azimuth"
      ? (at + delta + values.length) % values.length
      : Math.min(values.length - 1, Math.max(0, at + delta));
  return { ...pose, [axis]: values[next] ?? pose[axis] };
}
