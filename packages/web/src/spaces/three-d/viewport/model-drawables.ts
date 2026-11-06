// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Line, Mesh, Points } from 'three';
import type { Object3D } from 'three';

/**
 * Recognize every glTF primitive object that owns geometry and material: triangles, lines and points.
 * @param object - A node of a parsed model.
 * @returns Whether the node draws a primitive.
 * @throws {never} Never.
 */
export function isDrawable(object: Object3D): object is Mesh | Line | Points {
  return object instanceof Mesh || object instanceof Line || object instanceof Points;
}
