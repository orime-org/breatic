// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { Box3, Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { focusSceneBounds, updateSceneCameraRange } from '../scene-camera';

const bounds = new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(10000.5, 0.5, 0.5));

describe('scene camera framing', () => {
  it.each([1, 0.5, 2])('fits distant selected models inside the actual frustum at aspect %s', (aspect) => {
    const camera = new PerspectiveCamera(45, aspect, 0.05, 5000);
    camera.position.set(0, 0, 10);
    const target = new Vector3();
    focusSceneBounds(camera, target, bounds);
    updateSceneCameraRange(camera, bounds);
    camera.updateMatrixWorld(true);
    expect(target.toArray()).toEqual([5000, 0, 0]);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const corner = new Vector3(x, y, z);
          expect(frustum.containsPoint(corner)).toBe(true);
          const projected = corner.project(camera);
          expect(projected.toArray().every(Number.isFinite)).toBe(true);
          expect(Math.abs(projected.x)).toBeLessThan(1);
          expect(Math.abs(projected.y)).toBeLessThan(1);
          expect(Math.abs(projected.z)).toBeLessThan(1);
        }
      }
    }
  });

  it('keeps models visible after navigation or restoration beyond the old far plane', () => {
    const camera = new PerspectiveCamera(45, 1, 0.05, 5000);
    camera.position.set(0, 0, 6000);
    camera.lookAt(0, 0, 0);
    const model = new Box3(new Vector3(-100, -100, -100), new Vector3(100, 100, 100));
    updateSceneCameraRange(camera, model);
    camera.updateMatrixWorld(true);
    expect(camera.far).toBeGreaterThan(6100);
    expect(camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
    expect(new Vector3().project(camera).z).toBeLessThan(1);
  });

  it('leaves an empty selection and personal camera unchanged', () => {
    const camera = new PerspectiveCamera(45, 1, 0.05, 5000);
    camera.position.set(5, 4, 3);
    const target = new Vector3(1, 2, 3);
    focusSceneBounds(camera, target, new Box3());
    updateSceneCameraRange(camera, new Box3());
    expect(camera.position.toArray()).toEqual([5, 4, 3]);
    expect(target.toArray()).toEqual([1, 2, 3]);
    expect(camera.far).toBe(5000);
  });
});
