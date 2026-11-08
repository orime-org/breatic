// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

/**
 * Build the project-owned procedural stage block; the built-in figure is the
 * rigged mannequin asset `loadSceneModel` reads (inner#1692).
 * @param id - The built-in source identifier, separate from object identity.
 * @param color - The current semantic object colour.
 * @returns A template rooted at the floor in metres, with Y pointing up.
 * @throws {never} Never directly.
 */
export function createBuiltinModel(id: 'box', color: string): Group {
  const root = new Group();
  const block = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color, roughness: 0.8 }));
  block.name = id;
  block.position.set(0, 0.5, 0);
  root.add(block);
  return root;
}
