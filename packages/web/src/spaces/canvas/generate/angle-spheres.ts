// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two spheres one control draws (inner#1304): the camera of Qwen Image
 * Multiple Angles, and the relight tool's light. They differ in their grid,
 * their axes, where Reset puts them and what the control is called.
 */

import {
  CAMERA_ANGLE_AXES,
  CAMERA_ANGLE_GRID,
  DEFAULT_CAMERA_ANGLE,
  DEFAULT_LIGHT_ANGLE,
  LIGHT_ANGLE_AXES,
  LIGHT_ANGLE_GRID,
  type AngleGrid,
  type CameraAngle,
  type CameraAngleAxis,
} from '@breatic/shared';

/** The params a sphere's pose is written to; a light has no distance. */
export interface AngleParams {
  azimuth: string;
  elevation: string;
  distance?: string;
}

/** One sphere's rules. */
export interface AngleSphere {
  grid: AngleGrid;
  /** The axes it sets, in the order they are named and drawn. */
  axes: readonly CameraAngleAxis[];
  /** Where Reset puts it, and what an unset param reads as. */
  reset: CameraAngle;
  /** The control's name on screen. */
  titleKey: string;
  /** What sits on the sphere: a camera looking in, or a light shining in. */
  marker: 'camera' | 'light';
}

export const CAMERA_SPHERE: AngleSphere = {
  grid: CAMERA_ANGLE_GRID,
  axes: CAMERA_ANGLE_AXES,
  reset: DEFAULT_CAMERA_ANGLE,
  titleKey: 'canvas.generatePanel.cameraAngle.title',
  marker: 'camera',
};

export const LIGHT_SPHERE: AngleSphere = {
  grid: LIGHT_ANGLE_GRID,
  axes: LIGHT_ANGLE_AXES,
  reset: DEFAULT_LIGHT_ANGLE,
  titleKey: 'canvas.miniTool.relight.lightTitle',
  marker: 'light',
};
