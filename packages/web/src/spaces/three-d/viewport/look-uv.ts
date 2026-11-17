// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BufferAttribute, BufferGeometry, Matrix4, Vector3, type InterleavedBufferAttribute, type Mesh, type Object3D, type TypedArray,
} from 'three';

/** The projection a triangle uses: the main axis of its face normal and that normal's sign on it. */
type FaceAxis = 'x+' | 'x-' | 'y+' | 'y-' | 'z+' | 'z-';

const ab = new Vector3();
const cb = new Vector3();

/**
 * The main axis of a triangle's face normal, with three's winding (c − b) × (a − b).
 * @param a - First corner.
 * @param b - Second corner.
 * @param c - Third corner.
 * @returns The axis and sign; a degenerate triangle reads as negative.
 */
function faceAxis(a: Vector3, b: Vector3, c: Vector3): FaceAxis {
  const n = cb.subVectors(c, b).cross(ab.subVectors(a, b));
  const x = Math.abs(n.x); const y = Math.abs(n.y); const z = Math.abs(n.z);
  const axis = x >= y && x >= z ? 'x' : z >= y ? 'z' : 'y';
  return `${axis}${n[axis] > 0 ? '+' : '-'}`;
}

/**
 * The UV of a rest point on a face projected along this axis, in metres; v grows downwards because look pictures
 * load with flipY false, and u grows to the right as seen from outside.
 * @param p - The rest point in template-root space.
 * @param axis - The face's projection.
 * @returns The UV.
 */
function project(p: Vector3, axis: FaceAxis): [number, number] {
  switch (axis) {
    case 'x+': return [-p.z, -p.y];
    case 'x-': return [p.z, -p.y];
    case 'z+': return [p.x, -p.y];
    case 'z-': return [-p.x, -p.y];
    case 'y+': return [p.x, p.z];
    case 'y-': return [p.x, -p.z];
  }
}

/**
 * A copy of an attribute holding the listed source items in order.
 * @param source - The source attribute.
 * @param items - Source item indices.
 * @returns The new attribute.
 */
function gather(source: BufferAttribute | InterleavedBufferAttribute, items: readonly number[]): BufferAttribute {
  const size = source.itemSize;
  const Typed = source.array.constructor as new (length: number) => TypedArray;
  const target = new BufferAttribute(new Typed(items.length * size), size, source.normalized);
  // getComponent and setComponent read interleaved storage and convert normalized values both ways.
  items.forEach((item, index) => {
    for (let k = 0; k < size; k++) target.setComponent(index, k, source.getComponent(item, k));
  });
  return target;
}

/**
 * Generate UVs on one mesh without them: each triangle projected along its face axis, a vertex shared by triangles on
 * different axes split into one copy per axis with every attribute and morph attribute copied.
 * @param mesh - A triangle mesh whose geometry has no `uv`.
 * @param toRoot - Mesh space to template-root space.
 */
function generateMeshUvs(mesh: Mesh, toRoot: Matrix4): void {
  const source = mesh.geometry;
  const count = source.attributes.position!.count;
  const rest = Array.from({ length: count }, (_, i) => mesh.getVertexPosition(i, new Vector3()).applyMatrix4(toRoot));
  const corners = source.index ? Array.from(source.index.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i);
  const copies = new Map<string, number>();
  const items: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let t = 0; t + 2 < corners.length; t += 3) {
    const triangle = [corners[t]!, corners[t + 1]!, corners[t + 2]!];
    const axis = faceAxis(rest[triangle[0]!]!, rest[triangle[1]!]!, rest[triangle[2]!]!);
    for (const vertex of triangle) {
      const key = `${vertex}:${axis}`;
      let copy = copies.get(key);
      if (copy === undefined) {
        copy = items.length;
        copies.set(key, copy);
        items.push(vertex);
        uvs.push(...project(rest[vertex]!, axis));
      }
      index.push(copy);
    }
  }
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, gather(attribute, items));
  for (const [name, targets] of Object.entries(source.morphAttributes)) {
    geometry.morphAttributes[name] = targets.map((target) => gather(target, items));
  }
  geometry.morphTargetsRelative = source.morphTargetsRelative;
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(index);
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  geometry.userData = { ...source.userData };
  geometry.boundingBox = source.boundingBox?.clone() ?? null;
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
  mesh.geometry = geometry;
}

/**
 * Give every triangle mesh without UVs under a template root UVs a look picture can tile on (inner#1693 design 5.1):
 * rest positions in root metres, one projection per triangle, a hard seam where the projection changes. Each mesh gets
 * its own geometry, so meshes that shared one get UVs from their own place. Lines, points and meshes with UVs are left alone.
 * @param root - The template root, before any instance clones it.
 */
export function generateLookUvs(root: Object3D): void {
  root.updateMatrixWorld(true);
  const fromRoot = new Matrix4().copy(root.matrixWorld).invert();
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh && !mesh.geometry.attributes.uv && mesh.geometry.attributes.position) meshes.push(mesh);
  });
  for (const mesh of meshes) generateMeshUvs(mesh, new Matrix4().multiplyMatrices(fromRoot, mesh.matrixWorld));
}
