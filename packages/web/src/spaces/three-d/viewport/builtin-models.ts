// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { BoxGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import type { BufferGeometry } from 'three';

/**
 * Build the project-owned procedural sources used by scene foundation.
 * @param id - A stable source identifier, separate from object identity.
 * @param color - The current semantic object colour.
 * @returns A template rooted at the floor in metres, with Y pointing up.
 * @throws {never} Never directly.
 */
export function createBuiltinModel(id: 'figure' | 'box', color: string): Group {
  const root = new Group();
  const material = new MeshStandardMaterial({ color, roughness: 0.8 });
  /**
   * Add one owned procedural part.
   * @param geometry - The procedural shape whose geometry will belong to this model template.
   * @param x - The part centre along the template-local X axis, in metres.
   * @param y - The part centre above the template origin along Y, in metres.
   * @param z - The part centre along the template-local Z axis, in metres.
   * @throws {never} Never.
   */
  const part = (geometry: BufferGeometry, x: number, y: number, z: number): void => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    root.add(mesh);
  };
  if (id === 'box') {
    part(new BoxGeometry(1, 1, 1), 0, 0.5, 0);
  } else {
    part(new SphereGeometry(0.14, 20, 16), 0, 1.64, 0);
    part(new BoxGeometry(0.38, 0.55, 0.23), 0, 1.2, 0);
    part(new BoxGeometry(0.33, 0.18, 0.22), 0, 0.86, 0);
    for (const side of [-1, 1]) {
      part(new BoxGeometry(0.13, 0.56, 0.15), side * 0.29, 1.16, 0);
      part(new BoxGeometry(0.14, 0.72, 0.17), side * 0.1, 0.44, 0);
      part(new BoxGeometry(0.16, 0.12, 0.29), side * 0.1, 0.08, 0.06);
    }
  }
  return root;
}
