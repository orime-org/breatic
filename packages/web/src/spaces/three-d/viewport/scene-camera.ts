// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { MathUtils, Sphere, Vector3 } from 'three';
import type { Box3, PerspectiveCamera } from 'three';

/**
 * Frame loaded content without changing the scene or another user's camera.
 * @param camera - This viewport's perspective camera.
 * @param target - This viewport's mutable Orbit target.
 * @param bounds - Loaded selection bounds in world coordinates.
 */
export function focusSceneBounds(camera: PerspectiveCamera, target: Vector3, bounds: Box3): void {
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new Vector3());
  const radius = bounds.getBoundingSphere(new Sphere()).radius;
  const verticalHalfAngle = MathUtils.degToRad(camera.getEffectiveFOV()) / 2;
  const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
  const distance = Math.max(radius / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle)) * 1.1, 3);
  const direction = camera.position.clone().sub(target).normalize();
  target.copy(center);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(target);
}

/**
 * Update the viewport projection for its loaded content and personal camera.
 * @param camera - This viewport's perspective camera.
 * @param bounds - Loaded model bounds in world coordinates.
 */
export function updateSceneCameraRange(camera: PerspectiveCamera, bounds: Box3): void {
  if (bounds.isEmpty()) return;
  const sphere = bounds.getBoundingSphere(new Sphere());
  const far = Math.max(5000, (camera.position.distanceTo(sphere.center) + sphere.radius) * 1.1);
  if (camera.far === far) return;
  camera.far = far;
  camera.updateProjectionMatrix();
}
