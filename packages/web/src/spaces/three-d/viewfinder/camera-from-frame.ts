// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { SCENE_FOCAL_LENGTH_MAX, SCENE_FOCAL_LENGTH_MIN, SCENE_FREE_RATIO_MAX, SCENE_FREE_RATIO_MIN, VIEWFINDER_RATIOS, type ViewfinderRatio } from '@breatic/shared';

import type { ViewfinderRect } from '@web/spaces/three-d/viewfinder/viewfinder-geometry';
import { CAMERA_FILM_GAUGE } from '@web/spaces/three-d/viewport/director-objects';
import { SCENE_VIEW_FOV } from '@web/spaces/three-d/viewport/scene-camera';
import type { SceneFrozenPose, SceneQuaternion, SceneVector3 } from '@web/spaces/three-d/viewport/scene-viewport-props';
import { viewfinderRatioValue } from '@web/spaces/three-d/viewfinder/viewfinder-geometry';

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
  const main = new PerspectiveCamera(SCENE_VIEW_FOV, viewport.width / viewport.height);
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
  const filmHeight = CAMERA_FILM_GAUGE / Math.max(frame.width / frame.height, 1);
  const focalLength = MathUtils.clamp(filmHeight / (2 * Math.tan(span / 2)), SCENE_FOCAL_LENGTH_MIN, SCENE_FOCAL_LENGTH_MAX);
  return { position: view.position.toArray() as SceneVector3, rotation: aimed.quaternion.toArray() as SceneQuaternion, focalLength };
}

/**
 * The rotation of a view that stands at a position and looks at a target, upright.
 * @param position - Where it stands.
 * @param target - What it looks at.
 * @returns The rotation.
 */
export function lookRotation(position: SceneVector3, target: SceneVector3): SceneQuaternion {
  const aimed = new PerspectiveCamera();
  aimed.position.fromArray(position);
  aimed.lookAt(new Vector3().fromArray(target));
  return aimed.quaternion.toArray() as SceneQuaternion;
}

/** Where a new light goes relative to the orbit centre (inner#1694 design 3.6), in scene units. */
const LIGHT_ABOVE = 3.5;
const LIGHT_TOWARD_VIEWER = 2.5;
const LIGHT_LEFT = 2;

/**
 * A new light's pose: above the orbit centre, toward the viewer and to their left, aimed at the centre.
 * @param centre - The orbit centre, or the pivot of the camera being looked through.
 * @param viewer - Where the view stands.
 * @returns The light's position and rotation.
 */
export function newLightPose(centre: SceneVector3, viewer: SceneVector3): { position: SceneVector3; rotation: SceneQuaternion } {
  const middle = new Vector3().fromArray(centre);
  const toward = new Vector3().fromArray(viewer).sub(middle).setY(0);
  if (toward.lengthSq() === 0) toward.set(0, 0, 1);
  toward.normalize();
  const left = toward.clone().cross(new Vector3(0, 1, 0)).normalize();
  const position = middle.clone().addScaledVector(toward, LIGHT_TOWARD_VIEWER).addScaledVector(left, LIGHT_LEFT).setY(middle.y + LIGHT_ABOVE);
  return { position: position.toArray() as SceneVector3, rotation: lookRotation(position.toArray() as SceneVector3, centre) };
}

/**
 * {@link cameraFromFrame} for a view given as its position and orbit target.
 * @param view - The free view.
 * @param view.position - Where it stands.
 * @param view.target - What it orbits.
 * @param frame - The frame, in viewport pixels.
 * @param viewport - The viewport size.
 * @param viewport.width - Its width.
 * @param viewport.height - Its height.
 * @returns The camera's position, rotation and focal length.
 */
export function cameraFromView(view: { position: SceneVector3; target: SceneVector3 }, frame: ViewfinderRect,
  viewport: { width: number; height: number }): { position: SceneVector3; rotation: SceneQuaternion; focalLength: number } {
  const quaternion = new Quaternion().fromArray(lookRotation(view.position, view.target));
  return cameraFromFrame({ position: new Vector3().fromArray(view.position), quaternion }, frame, viewport);
}

/**
 * The camera a still was taken with, for saving it once its camera is gone: its pose, the lens of its vertical field of
 * view on the 36 mm gauge, and the frame of its width over height (Free when no fixed frame matches).
 * @param pose - The still's camera pose.
 * @returns The camera's position, rotation, focal length, frame and free ratio.
 */
export function cameraFromStill(pose: SceneFrozenPose): { position: SceneVector3; rotation: SceneQuaternion; focalLength: number; frame: ViewfinderRatio; freeRatio: number } {
  const filmHeight = CAMERA_FILM_GAUGE / Math.max(pose.aspect, 1);
  const focalLength = MathUtils.clamp(filmHeight / (2 * Math.tan(MathUtils.degToRad(pose.fov) / 2)), SCENE_FOCAL_LENGTH_MIN, SCENE_FOCAL_LENGTH_MAX);
  const frame = VIEWFINDER_RATIOS.find((ratio) => ratio !== 'Free' && Math.abs((viewfinderRatioValue(ratio) ?? 0) - pose.aspect) < 1e-3) ?? 'Free';
  return { position: pose.position, rotation: pose.quaternion, focalLength, frame, freeRatio: MathUtils.clamp(pose.aspect, SCENE_FREE_RATIO_MIN, SCENE_FREE_RATIO_MAX) };
}
