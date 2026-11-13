// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { MathUtils, PerspectiveCamera, Vector3, type Quaternion } from 'three';
import { SCENE_FOCAL_LENGTH_MAX, SCENE_FOCAL_LENGTH_MIN } from '@breatic/shared';

import type { ViewfinderRect } from '@web/spaces/three-d/viewfinder/viewfinder-geometry';
import type { SceneQuaternion, SceneVector3 } from '@web/spaces/three-d/viewport/scene-viewport-props';

/** The main view's vertical field of view, in degrees. */
const VIEW_FOV = 45;
/** The film gauge a camera's focal length is measured on, in millimetres. */
const FILM_GAUGE = 36;

/**
 * A camera that sees what a frame on the free view shows (inner#1694 design 3.5): from the view's position,
 * upright, aimed along the frame centre's ray, with the lens that spans the frame's top and bottom rays.
 * @param view - The free view's pose.
 * @param view.position - Where it stands.
 * @param view.quaternion - Where it faces.
 * @param frame - The frame, in viewport pixels.
 * @param viewport - The viewport size.
 * @param viewport.width - Its width.
 * @param viewport.height - Its height.
 * @returns The camera's position, rotation and focal length in millimetres.
 */
export function cameraFromFrame(view: { position: Vector3; quaternion: Quaternion }, frame: ViewfinderRect,
  viewport: { width: number; height: number }): { position: SceneVector3; rotation: SceneQuaternion; focalLength: number } {
  const main = new PerspectiveCamera(VIEW_FOV, viewport.width / viewport.height);
  main.position.copy(view.position);
  main.quaternion.copy(view.quaternion);
  main.updateMatrixWorld(true);
  /**
   * The free view's ray through a viewport pixel.
   * @param x - Pixel column.
   * @param y - Pixel row.
   * @returns A unit direction.
   */
  const ray = (x: number, y: number): Vector3 => new Vector3((x / viewport.width) * 2 - 1, 1 - (y / viewport.height) * 2, 0.5)
    .unproject(main).sub(main.position).normalize();
  const centreX = frame.x + frame.width / 2;
  const centre = ray(centreX, frame.y + frame.height / 2);
  const span = ray(centreX, frame.y).angleTo(ray(centreX, frame.y + frame.height));
  const aimed = new PerspectiveCamera();
  aimed.position.copy(view.position);
  aimed.lookAt(view.position.clone().add(centre));
  const filmHeight = FILM_GAUGE / Math.max(frame.width / frame.height, 1);
  const focalLength = MathUtils.clamp(filmHeight / (2 * Math.tan(span / 2)), SCENE_FOCAL_LENGTH_MIN, SCENE_FOCAL_LENGTH_MAX);
  return { position: view.position.toArray() as SceneVector3, rotation: aimed.quaternion.toArray() as SceneQuaternion, focalLength };
}
