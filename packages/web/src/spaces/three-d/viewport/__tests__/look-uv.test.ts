// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UVs generated at template load for triangle meshes without them (inner#1693 design 5.1):
 * rest positions in template-root metres, one projection axis per triangle, a clean seam
 * where the axis changes, and images that read upright and unmirrored from outside.
 */

import {
  Bone, BoxGeometry, BufferAttribute, BufferGeometry, Group, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, Line, LineBasicMaterial, Matrix4, Mesh,
  MeshStandardMaterial, Points, PointsMaterial, Skeleton, SkinnedMesh, SphereGeometry, Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';

import * as lookUv from '@web/spaces/three-d/viewport/look-uv';

/**
 * The function under test.
 * @returns generateLookUvs.
 * @throws {AssertionError} When it is not exported.
 */
function generate(): (root: Group) => void {
  const candidate = (lookUv as Record<string, unknown>).generateLookUvs;
  expect(candidate, 'generateLookUvs must be exported').toBeTypeOf('function');
  return candidate as (root: Group) => void;
}

/** A mesh's geometry without its UVs. */
function withoutUv<T extends BufferGeometry>(geometry: T): T {
  geometry.deleteAttribute('uv');
  return geometry;
}

/** The triangles of a geometry as vertex index triples. */
function triangles(geometry: BufferGeometry): number[][] {
  const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
  const at = (i: number): number => (geometry.index ? geometry.index.getX(i) : i);
  return Array.from({ length: count / 3 }, (_, t) => [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)]);
}

/** The main axis of a triangle's face normal, from rest positions in root space. */
function faceAxis(points: Vector3[]): { axis: 'x' | 'y' | 'z'; sign: number } {
  const [a, b, c] = points as [Vector3, Vector3, Vector3];
  const n = new Vector3().subVectors(c, b).cross(new Vector3().subVectors(a, b));
  const abs = { x: Math.abs(n.x), y: Math.abs(n.y), z: Math.abs(n.z) };
  const axis = abs.x >= abs.y && abs.x >= abs.z ? 'x' : abs.z >= abs.y ? 'z' : 'y';
  return { axis, sign: Math.sign(n[axis]) };
}

/** The UV the design's table gives a rest point on a face with this axis. */
function expectedUv(p: Vector3, face: { axis: 'x' | 'y' | 'z'; sign: number }): [number, number] {
  if (face.axis === 'x') return [face.sign > 0 ? -p.z : p.z, -p.y];
  if (face.axis === 'z') return [face.sign > 0 ? p.x : -p.x, -p.y];
  return [p.x, face.sign > 0 ? p.z : -p.z];
}

/** Rest positions of a mesh's vertices in its template root's space. */
function restPoints(mesh: Mesh, root: Group): Vector3[] {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
  const position = mesh.geometry.attributes.position;
  return Array.from({ length: position.count }, (_, i) => mesh.getVertexPosition(i, new Vector3()).applyMatrix4(toRoot));
}

describe('generateLookUvs', () => {
  it('projects every triangle of an indexed smooth sphere along its own face axis', () => {
    const root = new Group();
    const mesh = new Mesh(withoutUv(new SphereGeometry(0.5, 16, 12)), new MeshStandardMaterial());
    root.add(mesh);
    generate()(root);
    const uv = mesh.geometry.attributes.uv;
    expect(uv, 'a uv attribute is generated').toBeDefined();
    const points = restPoints(mesh, root);
    for (const [a, b, c] of triangles(mesh.geometry)) {
      const face = faceAxis([points[a]!, points[b]!, points[c]!]);
      for (const index of [a!, b!, c!]) {
        const [u, v] = expectedUv(points[index]!, face);
        expect(uv!.getX(index)).toBeCloseTo(u, 5);
        expect(uv!.getY(index)).toBeCloseTo(v, 5);
      }
    }
  });

  it('measures the UVs in metres of the template root, through node scale', () => {
    const root = new Group();
    const holder = new Group(); holder.scale.setScalar(0.01);
    const mesh = new Mesh(withoutUv(new BoxGeometry(100, 100, 100)), new MeshStandardMaterial());
    holder.add(mesh); root.add(holder);
    generate()(root);
    const uv = mesh.geometry.attributes.uv!;
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i));
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1, 5);
  });

  it('measures a skinned mesh at its skeleton rest pose, not at the identity bind matrix', () => {
    const root = new Group();
    const bone = new Bone();
    root.add(bone);
    const geometry = withoutUv(new BoxGeometry(2, 2, 2));
    const count = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(count * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
    root.add(mesh);
    // A quantised skin keeps its scale in the inverse bind matrix, as gltfpack writes it.
    mesh.bind(new Skeleton([bone], [new Matrix4().makeScale(0.5, 0.5, 0.5)]), new Matrix4());
    root.updateMatrixWorld(true);
    generate()(root);
    const uv = mesh.geometry.attributes.uv!;
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i));
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(1, 5);
  });

  it('splits a vertex shared by triangles on different axes, carrying its skin attributes along', () => {
    const root = new Group();
    const geometry = withoutUv(new SphereGeometry(0.5, 8, 6));
    const count = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(count * 4).fill(0.25), 4));
    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    root.add(mesh);
    generate()(root);
    const out = mesh.geometry;
    expect(out.attributes.position.count).toBeGreaterThan(count);
    expect(out.attributes.skinIndex!.count).toBe(out.attributes.position.count);
    expect(out.attributes.skinWeight!.count).toBe(out.attributes.position.count);
  });

  it('reads an image upright and unmirrored on the front and the back of a box', () => {
    const root = new Group();
    const mesh = new Mesh(withoutUv(new BoxGeometry(1, 1, 1)), new MeshStandardMaterial());
    root.add(mesh);
    generate()(root);
    const points = restPoints(mesh, root);
    const uv = mesh.geometry.attributes.uv!;
    const faces = triangles(mesh.geometry).map((tri) => ({ tri, face: faceAxis(tri.map((i) => points[i]!)) }));
    for (const sign of [1, -1]) {
      const vertices = faces.filter(({ face }) => face.axis === 'z' && face.sign === sign).flatMap(({ tri }) => tri);
      const top = vertices.find((i) => points[i]!.y > 0)!;
      const bottom = vertices.find((i) => points[i]!.y < 0 && points[i]!.x === points[top]!.x)!;
      // The image's top row is v = 0 (flipY false): the higher vertex has the smaller v.
      expect(uv.getY(top)).toBeLessThan(uv.getY(bottom));
      // Seen from outside, u grows to the viewer's right: +x on the front, -x on the back.
      const left = vertices.find((i) => points[i]!.x * sign < 0)!;
      const right = vertices.find((i) => points[i]!.x * sign > 0)!;
      expect(uv.getX(right)).toBeGreaterThan(uv.getX(left));
    }
  });

  it('projects a non-indexed mesh per triangle on its own attributes, adding no index', () => {
    const root = new Group();
    const source = withoutUv(new BoxGeometry(1, 2, 3).toNonIndexed());
    const mesh = new Mesh(source, new MeshStandardMaterial());
    mesh.position.set(0.5, 0, 0);
    root.add(mesh);
    const position = source.attributes.position;
    const normal = source.attributes.normal;
    generate()(root);
    const made = mesh.geometry;
    expect(made.index).toBeNull();
    expect(made.attributes.position).toBe(position);
    expect(made.attributes.normal).toBe(normal);
    const points = restPoints(mesh, root);
    const uv = made.attributes.uv!;
    expect(uv.count).toBe(position.count);
    for (const [a, b, c] of triangles(made)) {
      const face = faceAxis([points[a!]!, points[b!]!, points[c!]!]);
      for (const vertex of [a!, b!, c!]) {
        const [u, v] = expectedUv(points[vertex]!, face);
        expect(uv.getX(vertex)).toBeCloseTo(u);
        expect(uv.getY(vertex)).toBeCloseTo(v);
      }
    }
  });

  it('gives the meshes sharing one geometry one generated geometry, projected where the first of them stands', () => {
    const root = new Group();
    const shared = withoutUv(new BoxGeometry(1, 1, 1));
    const near = new Mesh(shared, new MeshStandardMaterial());
    const far = new Mesh(shared, new MeshStandardMaterial());
    far.position.set(10, 0, 0);
    const third = new Mesh(shared, new MeshStandardMaterial());
    third.position.set(0, 0, -10);
    root.add(near, far, third);
    generate()(root);
    expect(near.geometry).not.toBe(shared);
    expect(far.geometry).toBe(near.geometry);
    expect(third.geometry).toBe(near.geometry);
    const made = near.geometry;
    const points = restPoints(near, root);
    for (const [a, b, c] of triangles(made)) {
      const face = faceAxis([points[a!]!, points[b!]!, points[c!]!]);
      for (const vertex of [a!, b!, c!]) {
        const [u, v] = expectedUv(points[vertex]!, face);
        expect(made.attributes.uv!.getX(vertex)).toBeCloseTo(u);
        expect(made.attributes.uv!.getY(vertex)).toBeCloseTo(v);
      }
    }
  });

  it('indexes a generated geometry with 16-bit indices while its vertices fit', () => {
    const root = new Group();
    const mesh = new Mesh(withoutUv(new BoxGeometry(1, 1, 1)), new MeshStandardMaterial());
    root.add(mesh);
    generate()(root);
    expect(mesh.geometry.index!.array).toBeInstanceOf(Uint16Array);
  });

  it('projects an instanced mesh in its own coordinates without the instance matrices', () => {
    const root = new Group();
    const mesh = new InstancedMesh(withoutUv(new BoxGeometry(1, 1, 1)), new MeshStandardMaterial(), 2);
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(50, 0, 0));
    root.add(mesh);
    generate()(root);
    const uv = mesh.geometry.attributes.uv!;
    const us = Array.from({ length: uv.count }, (_, i) => Math.abs(uv.getX(i)));
    expect(Math.max(...us)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('leaves a mesh that has UVs, and lines and points, untouched', () => {
    const root = new Group();
    const textured = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    const before = textured.geometry.attributes.uv!.array.slice();
    const line = new Line(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), 3)), new LineBasicMaterial());
    const points = new Points(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1, 2, 0, 0]), 3)), new PointsMaterial());
    root.add(textured, line, points);
    generate()(root);
    expect(textured.geometry.attributes.uv!.array).toEqual(before);
    expect(line.geometry.attributes.uv).toBeUndefined();
    expect(line.geometry.attributes.normal).toBeUndefined();
    expect(points.geometry.attributes.uv).toBeUndefined();
    expect(points.geometry.attributes.normal).toBeUndefined();
  });
  it('keeps the stored values of quantized and interleaved attributes it copies (meshopt and KHR_mesh_quantization output)', () => {
    // Three triangles on two axes, so the shared vertex 0 is split and every attribute is gathered.
    const position = new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), 3);
    const normals = new InterleavedBuffer(new Int8Array([0, 0, 127, 0, 0, 0, 127, 0, 76, 102, 0, 0, -128, 0, 0, 0]), 4);
    const colours = new Uint8Array([255, 128, 0, 1, 2, 3, 200, 100, 50, 7, 8, 9]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', new InterleavedBufferAttribute(normals, 3, 0, true));
    // A second attribute in the same buffer, starting one value into each vertex.
    geometry.setAttribute('_shifted', new InterleavedBufferAttribute(normals, 2, 1, true));
    geometry.setAttribute('color', new BufferAttribute(colours, 3, true));
    geometry.setIndex([0, 1, 2, 0, 3, 1]);
    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    const root = new Group().add(mesh);
    generate()(root);
    const made = mesh.geometry;
    const index = made.index!;
    const stored = (attribute: BufferAttribute, vertex: number): number[] =>
      Array.from(attribute.array.slice(vertex * attribute.itemSize, (vertex + 1) * attribute.itemSize));
    const source = [0, 1, 2, 0, 3, 1];
    for (let corner = 0; corner < source.length; corner++) {
      const copy = index.getX(corner);
      const from = source[corner]!;
      expect(stored(made.attributes.normal as BufferAttribute, copy), `normal of corner ${corner}`)
        .toEqual(Array.from(normals.array.slice(from * 4, from * 4 + 3)));
      expect(stored(made.attributes._shifted as BufferAttribute, copy), `shifted of corner ${corner}`)
        .toEqual(Array.from(normals.array.slice(from * 4 + 1, from * 4 + 3)));
      expect(stored(made.attributes.color as BufferAttribute, copy), `colour of corner ${corner}`).toEqual(Array.from(colours.slice(from * 3, from * 3 + 3)));
    }
    expect(made.attributes.normal!.normalized).toBe(true);
    expect((made.attributes.normal as BufferAttribute).array).toBeInstanceOf(Int8Array);
  });
});

describe('generated UVs on a mirrored node (inner#1693 design 5.1)', () => {
  it('reads a mirrored face from outside the way three draws it', async () => {
    const three = await import('three');
    const { generateLookUvs } = await import('@web/spaces/three-d/viewport/look-uv');
    const positions = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1]);
    /** One triangle under a node with the given x scale and corner order. */
    const uvsOf = (scaleX: number, order: number[]): number[] => {
      const geometry = new three.BufferGeometry();
      geometry.setAttribute('position', new three.BufferAttribute(positions.slice(), 3));
      geometry.setIndex(order);
      const mesh = new three.Mesh(geometry, new three.MeshStandardMaterial());
      mesh.scale.set(scaleX, 1, 1);
      const root = new three.Group();
      root.add(mesh);
      generateLookUvs(root);
      return [...(mesh.geometry.getAttribute('uv').array as Float32Array)];
    };
    // Mirrored, three flips the front face, so the face seen from outside is the reversed winding unmirrored.
    const reversed = uvsOf(1, [0, 2, 1]);
    // Its corners come out in the order 0, 2, 1; put them back in vertex order.
    expect(uvsOf(-1, [0, 1, 2]).map((value) => value + 0)).toEqual([reversed[0], reversed[1], reversed[4], reversed[5], reversed[2], reversed[3]].map((value) => value! + 0));
  });

  it('reads a mirrored non-indexed face from outside the way three draws it', async () => {
    const three = await import('three');
    const { generateLookUvs } = await import('@web/spaces/three-d/viewport/look-uv');
    const corners = [[0, 0, 0], [0, 1, 0], [0, 0, 1]];
    /** One non-indexed triangle under a node with the given x scale and corner order. */
    const uvsOf = (scaleX: number, order: number[]): number[] => {
      const geometry = new three.BufferGeometry();
      geometry.setAttribute('position', new three.BufferAttribute(new Float32Array(order.flatMap((i) => corners[i]!)), 3));
      const mesh = new three.Mesh(geometry, new three.MeshStandardMaterial());
      mesh.scale.set(scaleX, 1, 1);
      const root = new three.Group();
      root.add(mesh);
      generateLookUvs(root);
      return [...(mesh.geometry.getAttribute('uv').array as Float32Array)].map((value) => value + 0);
    };
    const reversed = uvsOf(1, [0, 2, 1]);
    expect(uvsOf(-1, [0, 1, 2])).toEqual([reversed[0], reversed[1], reversed[4], reversed[5], reversed[2], reversed[3]]);
  });

  it('projects a geometry shared with a mirrored node from an unmirrored one, whatever the node order', async () => {
    const three = await import('three');
    const { generateLookUvs } = await import('@web/spaces/three-d/viewport/look-uv');
    /** The unmirrored node's UVs when the mirrored node is listed first or last. */
    const plainUvs = (mirroredFirst: boolean): number[] => {
      const geometry = new three.BufferGeometry();
      geometry.setAttribute('position', new three.BufferAttribute(new Float32Array([1, 0, 0, 1, 0, -1, 1, 1, 0]), 3));
      geometry.setIndex([0, 1, 2]);
      const plain = new three.Mesh(geometry, new three.MeshStandardMaterial());
      const mirror = new three.Mesh(geometry, new three.MeshStandardMaterial());
      mirror.scale.set(-1, 1, 1);
      const root = new three.Group();
      if (mirroredFirst) root.add(mirror, plain);
      else root.add(plain, mirror);
      generateLookUvs(root);
      expect(mirror.geometry).toBe(plain.geometry);
      return [...(plain.geometry.getAttribute('uv').array as Float32Array)].map((value) => value + 0);
    };
    expect(plainUvs(true)).toEqual(plainUvs(false));
  });

  it('projects a geometry shared with a zero-scale node from a node that draws it, even a mirrored one', async () => {
    const three = await import('three');
    const { generateLookUvs } = await import('@web/spaces/three-d/viewport/look-uv');
    /** How many different UVs the visible node gets when a zero-scale node is listed first. */
    const distinctUvs = (visibleScaleX: number): number => {
      const geometry = new three.BoxGeometry();
      geometry.deleteAttribute('uv');
      const hidden = new three.Mesh(geometry, new three.MeshStandardMaterial());
      hidden.scale.set(0, 0, 0);
      const visible = new three.Mesh(geometry, new three.MeshStandardMaterial());
      visible.scale.set(visibleScaleX, 1, 1);
      const root = new three.Group();
      root.add(hidden, visible);
      generateLookUvs(root);
      const uv = visible.geometry.getAttribute('uv').array as Float32Array;
      return new Set(Array.from({ length: uv.length / 2 }, (_, i) => `${uv[i * 2]! + 0},${uv[i * 2 + 1]! + 0}`)).size;
    };
    expect(distinctUvs(1)).toBeGreaterThan(1);
    expect(distinctUvs(-1)).toBeGreaterThan(1);
  });
});
