// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneObject } from '@breatic/shared';
import type { SceneTransformMode, SceneTransformPatch } from '@web/spaces/three-d/viewport/scene-viewport-props';

/** The native pivot is local; the scene document never stores it. */
export interface SceneTransformGesture {
  mode: SceneTransformMode;
  pivot: Matrix4;
  inverse: Matrix4;
  matrices: ReadonlyMap<string, Matrix4>;
}

/**
 * Capture complete object matrices about the approved shared centre.
 * @param objects - The selected, mutable scene objects.
 * @param mode - The native transform being started.
 * @returns The immutable starting matrices and pivot.
 * @throws {never} Never.
 */
export function createTransformGesture(objects: readonly SceneObject[], mode: SceneTransformMode): SceneTransformGesture {
  const centre = new Vector3();
  const matrices = new Map<string, Matrix4>();
  for (const object of objects) {
    const position = new Vector3().fromArray(object.position);
    centre.add(position);
    matrices.set(object.id, new Matrix4().compose(position, new Quaternion().fromArray(object.rotation), new Vector3().fromArray(object.scale)));
  }
  if (objects.length > 0) centre.divideScalar(objects.length);
  const orientation = mode === 'scale' && objects.length === 1 ? new Quaternion().fromArray(objects[0].rotation) : new Quaternion();
  const pivot = new Matrix4().compose(centre, orientation, new Vector3(1, 1, 1));
  return { mode, pivot, inverse: pivot.clone().invert(), matrices };
}

/**
 * Convert a native pivot delta into complete project-owned field tuples.
 * @param gesture - The captured start of one interaction.
 * @param pivot - The current world matrix of its temporary pivot.
 * @returns Only fields affected by this mode; invalid batches produce no patches.
 * @throws {never} Never.
 */
export function transformPatches(gesture: SceneTransformGesture, pivot: Matrix4): SceneTransformPatch[] {
  const delta = pivot.clone().multiply(gesture.inverse);
  const patches: SceneTransformPatch[] = [];
  for (const [id, matrix] of gesture.matrices) {
    const transformed = delta.clone().multiply(matrix);
    const position = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    transformed.decompose(position, rotation, scale);
    rotation.normalize();
    if (![...position.toArray(), ...rotation.toArray(), ...scale.toArray()].every(Number.isFinite) || scale.toArray().some((value) => value <= 0)) return [];
    const patch: SceneTransformPatch = { id };
    if (gesture.mode === 'translate' || gesture.matrices.size > 1) patch.position = position.toArray();
    if (gesture.mode === 'rotate') patch.rotation = rotation.toArray();
    if (gesture.mode === 'scale') patch.scale = scale.toArray();
    patches.push(patch);
  }
  return patches;
}

/**
 * Scale from the initial pointer, avoiding r173's centre-ray division.
 * @param horizontal - Pointer displacement in CSS pixels.
 * @param vertical - Upward pointer displacement in CSS pixels.
 * @param sensitivity - The production configuration's exponent per pixel.
 * @returns A finite positive ratio, or null when it cannot represent a scale.
 * @throws {never} Never.
 */
export function uniformScaleRatio(horizontal: number, vertical: number, sensitivity: number): number | null {
  const ratio = Math.exp((horizontal + vertical) * sensitivity);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}
