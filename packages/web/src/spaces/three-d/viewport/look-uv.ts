// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BufferAttribute, BufferGeometry, Matrix4, Vector3, type InterleavedBufferAttribute, type Mesh, type Object3D, type TypedArray,
} from 'three';

/**
 * The projection a triangle uses: the main axis of its face normal and that normal's sign on it, numbered x+ 0, x- 1,
 * y+ 2, y- 3, z+ 4, z- 5.
 */
type FaceAxis = 0 | 1 | 2 | 3 | 4 | 5;
const AXES = 6;

/**
 * The main axis of a triangle's face normal, with three's winding (c − b) × (a − b).
 * @param rest - Rest positions, three numbers per vertex.
 * @param a - First corner's vertex.
 * @param b - Second corner's vertex.
 * @param c - Third corner's vertex.
 * @returns The axis and sign; a degenerate triangle reads as negative.
 */
function faceAxis(rest: Float32Array, a: number, b: number, c: number): FaceAxis {
  const bx = rest[b * 3]!; const by = rest[b * 3 + 1]!; const bz = rest[b * 3 + 2]!;
  const cbx = rest[c * 3]! - bx; const cby = rest[c * 3 + 1]! - by; const cbz = rest[c * 3 + 2]! - bz;
  const abx = rest[a * 3]! - bx; const aby = rest[a * 3 + 1]! - by; const abz = rest[a * 3 + 2]! - bz;
  const nx = cby * abz - cbz * aby; const ny = cbz * abx - cbx * abz; const nz = cbx * aby - cby * abx;
  const x = Math.abs(nx); const y = Math.abs(ny); const z = Math.abs(nz);
  if (x >= y && x >= z) return nx > 0 ? 0 : 1;
  if (z >= y) return nz > 0 ? 4 : 5;
  return ny > 0 ? 2 : 3;
}

/**
 * Write the UV of a rest point on a face projected along this axis, in metres; v grows downwards because look pictures
 * load with flipY false, and u grows to the right as seen from outside.
 * @param rest - Rest positions, three numbers per vertex.
 * @param vertex - The vertex.
 * @param axis - The face's projection.
 * @param uvs - The target, two numbers per copy.
 * @param at - The copy to write.
 */
function project(rest: Float32Array, vertex: number, axis: FaceAxis, uvs: Float32Array, at: number): void {
  const x = rest[vertex * 3]!; const y = rest[vertex * 3 + 1]!; const z = rest[vertex * 3 + 2]!;
  const [u, v] = axis === 0 ? [-z, -y] : axis === 1 ? [z, -y] : axis === 4 ? [x, -y] : axis === 5 ? [-x, -y] : axis === 2 ? [x, z] : [x, -z];
  uvs[at * 2] = u;
  uvs[at * 2 + 1] = v;
}

/**
 * A copy of an attribute holding the listed source items in order.
 * @param source - The source attribute.
 * @param items - Source item indices.
 * @returns The new attribute.
 */
function gather(source: BufferAttribute | InterleavedBufferAttribute, items: Uint32Array): BufferAttribute {
  const size = source.itemSize;
  const Typed = source.array.constructor as new (length: number) => TypedArray;
  const target = new BufferAttribute(new Typed(items.length * size), size, source.normalized);
  // Stored values are copied as they are: getComponent would decode normalized integers into fractions.
  const interleaved = (source as InterleavedBufferAttribute).isInterleavedBufferAttribute ? source as InterleavedBufferAttribute : null;
  const from = interleaved ? interleaved.data.array : source.array;
  const stride = interleaved ? interleaved.data.stride : size;
  const offset = interleaved ? interleaved.offset : 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]! * stride + offset;
    for (let k = 0; k < size; k++) target.array[index * size + k] = from[item + k]!;
  }
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
  const rest = new Float32Array(count * 3);
  const point = new Vector3();
  for (let i = 0; i < count; i++) mesh.getVertexPosition(i, point).applyMatrix4(toRoot).toArray(rest, i * 3);
  const corners = source.index ? (source.index.array as ArrayLike<number>) : null;
  const cornerCount = corners ? corners.length : count;
  const triangles = Math.floor(cornerCount / 3) * 3;
  const copies = new Int32Array(count * AXES).fill(-1);
  const items = new Uint32Array(triangles);
  const uvs = new Float32Array(triangles * 2);
  const index = new Uint32Array(triangles);
  let made = 0;
  for (let t = 0; t < triangles; t += 3) {
    const a = corners ? corners[t]! : t; const b = corners ? corners[t + 1]! : t + 1; const c = corners ? corners[t + 2]! : t + 2;
    const axis = faceAxis(rest, a, b, c);
    for (let k = 0; k < 3; k++) {
      const vertex = k === 0 ? a : k === 1 ? b : c;
      const slot = vertex * AXES + axis;
      let copy = copies[slot]!;
      if (copy < 0) {
        copy = made++;
        copies[slot] = copy;
        items[copy] = vertex;
        project(rest, vertex, axis, uvs, copy);
      }
      index[t + k] = copy;
    }
  }
  const used = items.subarray(0, made);
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, gather(attribute, used));
  for (const [name, targets] of Object.entries(source.morphAttributes)) {
    geometry.morphAttributes[name] = targets.map((target) => gather(target, used));
  }
  geometry.morphTargetsRelative = source.morphTargetsRelative;
  geometry.setAttribute('uv', new BufferAttribute(uvs.slice(0, made * 2), 2));
  geometry.setIndex(new BufferAttribute(index, 1));
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
