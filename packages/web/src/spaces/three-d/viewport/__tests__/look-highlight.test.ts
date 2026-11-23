// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Highlighting a selected part and picking a part from a hit (inner#1693 design 5.5, 5.6).
 */

import {
  Bone, Box3, BoxGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, Points, PointsMaterial, Skeleton, SkinnedMesh,
  Uint16BufferAttribute, type Intersection,
} from 'three';
import { describe, expect, it, vi } from 'vitest';

import * as highlight from '@web/spaces/three-d/viewport/look-highlight';

/** A model whose part 0 spans two meshes and part 1 one mesh. */
function model(): { root: Group; meshes: Mesh[] } {
  const root = new Group();
  const materials = ['0', '0', '1'].map((part) => { const material = new MeshStandardMaterial(); material.userData.lookPart = part; return material; });
  const meshes = materials.map((material) => new Mesh(new BoxGeometry(), material));
  meshes.forEach((mesh) => { mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere(); root.add(mesh); });
  return { root, meshes };
}

/**
 * An export of the module under test.
 * @param name - Its name.
 * @returns The export.
 * @throws {AssertionError} When it is missing.
 */
function exported<T>(name: string): T {
  const candidate = (highlight as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported`).toBeTypeOf('function');
  return candidate as T;
}

describe('part highlight', () => {
  it('adds one overlay child to every mesh of the part, sharing geometry and bounds, out of picking and shadows', () => {
    const { root, meshes } = model();
    const add = exported<(root: Group, part: string) => { remove: () => void; overlays: Mesh[] }>('addPartHighlight');
    const shown = add(root, '0');
    expect(shown.overlays).toHaveLength(2);
    shown.overlays.forEach((overlay, index) => {
      expect(overlay.parent).toBe(meshes[index]);
      expect(overlay.geometry).toBe(meshes[index]!.geometry);
      expect(overlay.castShadow).toBe(false);
      expect(overlay.receiveShadow).toBe(false);
      expect(overlay.userData.lookHighlight).toBe(true);
      const hits: unknown[] = [];
      overlay.raycast({} as never, hits as never);
      expect(hits).toEqual([]);
    });
    expect(meshes[2]!.children).toHaveLength(0);
    shown.remove();
    meshes.forEach((mesh) => expect(mesh.children).toHaveLength(0));
  });

  it('covers a line and a points part with an overlay of the same kind and point size', () => {
    const root = new Group();
    const lineMaterial = new LineBasicMaterial(); lineMaterial.userData.lookPart = '0';
    const pointsMaterial = new PointsMaterial({ size: 4, sizeAttenuation: false }); pointsMaterial.userData.lookPart = '0';
    const line = new LineSegments(new BoxGeometry(), lineMaterial);
    const points = new Points(new BoxGeometry(), pointsMaterial);
    root.add(line, points);
    const shown = exported<(root: Group, part: string, color: string) => { remove: () => void; overlays: Array<LineSegments | Points> }>('addPartHighlight')(root, '0', '#3b6fd8');
    expect(shown.overlays).toHaveLength(2);
    const [lineOverlay, pointsOverlay] = shown.overlays as [LineSegments, Points];
    expect(lineOverlay.isLineSegments).toBe(true);
    expect(lineOverlay.geometry).toBe(line.geometry);
    expect(lineOverlay.parent).toBe(line);
    expect(pointsOverlay.isPoints).toBe(true);
    expect((pointsOverlay.material as PointsMaterial).size).toBe(4);
    expect((pointsOverlay.material as PointsMaterial).sizeAttenuation).toBe(false);
    for (const overlay of shown.overlays) {
      const hits: unknown[] = [];
      overlay.raycast({} as never, hits as never);
      expect(hits).toEqual([]);
      expect(overlay.userData.lookHighlight).toBe(true);
    }
    const materials = shown.overlays.map((overlay) => overlay.material as LineBasicMaterial | PointsMaterial);
    for (const material of materials) expect(`#${material.color.getHexString()}`).toBe('#3b6fd8');
    const disposals = materials.map((material) => vi.spyOn(material, 'dispose'));
    shown.remove();
    expect(line.children).toHaveLength(0);
    expect(points.children).toHaveLength(0);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('picking a part', () => {
  it('reads the part of the material hit, by face group on a multi-material mesh', () => {
    const { meshes } = model();
    const partAt = exported<(hit: Intersection) => string | null>('partAtHit');
    expect(partAt({ object: meshes[2]!, face: { materialIndex: 0 } } as unknown as Intersection)).toBe('1');
    const multi = new Mesh(new BoxGeometry(), [meshes[0]!.material as MeshStandardMaterial, meshes[2]!.material as MeshStandardMaterial]);
    expect(partAt({ object: multi, face: { materialIndex: 1 } } as unknown as Intersection)).toBe('1');
    expect(partAt({ object: multi, face: { materialIndex: 0 } } as unknown as Intersection)).toBe('0');
  });

  it('decides a click: joints first in pose mode, shift toggles, a second plain click picks a part', () => {
    const decide = exported<(input: { shift: boolean; hitId: string | null; onlySelected: string | null; part: string | null }) =>
      { kind: 'select'; id: string | null; additive: boolean } | { kind: 'part'; part: string }>('decideScenePick');
    expect(decide({ shift: true, hitId: 'a', onlySelected: 'a', part: '0' })).toEqual({ kind: 'select', id: 'a', additive: true });
    expect(decide({ shift: false, hitId: 'a', onlySelected: 'a', part: '0' })).toEqual({ kind: 'part', part: '0' });
    expect(decide({ shift: false, hitId: 'b', onlySelected: 'a', part: '0' })).toEqual({ kind: 'select', id: 'b', additive: false });
    expect(decide({ shift: false, hitId: null, onlySelected: 'a', part: null })).toEqual({ kind: 'select', id: null, additive: false });
  });
});

describe('highlight bounds (inner#1693 design 5.5)', () => {
  it('shares the skinned mesh\'s bounds, so a pose change leaves the object\'s bounds on the posed shape', () => {
    const geometry = new BoxGeometry();
    const count = geometry.attributes.position!.count;
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(new Array(count).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
    const material = new MeshStandardMaterial(); material.userData.lookPart = '0';
    const mesh = new SkinnedMesh(geometry, material);
    const bone = new Bone(); mesh.add(bone); mesh.bind(new Skeleton([bone]));
    const root = new Group(); root.add(mesh); root.updateMatrixWorld(true);
    exported<(root: Group, part: string) => unknown>('addPartHighlight')(root, '0');
    new Box3().expandByObject(root);
    bone.position.x = 10; root.updateMatrixWorld(true); mesh.skeleton.update(); mesh.computeBoundingBox();
    const box = new Box3().expandByObject(root);
    expect(box.min.x).toBeCloseTo(mesh.boundingBox!.min.x);
    expect(box.max.x).toBeCloseTo(mesh.boundingBox!.max.x);
  });
});


describe('the tint on a double-sided part', () => {
  it('draws on the side the part itself draws', async () => {
    const three = await import('three');
    const { addPartHighlight } = await import('@web/spaces/three-d/viewport/look-highlight');
    const material = new three.MeshStandardMaterial({ side: three.DoubleSide });
    material.userData.lookPart = '0';
    const root = new three.Group();
    root.add(new three.Mesh(new three.PlaneGeometry(), material));
    const highlight = addPartHighlight(root, '0');
    const overlay = highlight.overlays[0] as unknown as { material: { side: number } };
    expect(overlay.material.side).toBe(three.DoubleSide);
    highlight.remove();
  });

  it('gives each slot of a material array the side its own material draws and frees every tint once', async () => {
    const three = await import('three');
    const { addPartHighlight } = await import('@web/spaces/three-d/viewport/look-highlight');
    const slots = ([[three.DoubleSide, '0'], [three.BackSide, '0'], [three.FrontSide, '1']] as const).map(([side, part]) => {
      const material = new three.MeshStandardMaterial({ side });
      material.userData.lookPart = part;
      return material;
    });
    const geometry = new three.BoxGeometry();
    geometry.clearGroups();
    for (let slot = 0; slot < 3; slot++) geometry.addGroup(slot * 12, 12, slot);
    const root = new three.Group();
    root.add(new three.Mesh(geometry, slots));
    const highlight = addPartHighlight(root, '0', '#3b6fd8');
    const tints = (highlight.overlays[0] as unknown as { material: Array<{ side: number; visible: boolean; dispose: () => void }> }).material;
    expect(tints.map((tint) => [tint.side, tint.visible])).toEqual([[three.DoubleSide, true], [three.BackSide, true], [tints[2]!.side, false]]);
    const spies = [...new Set(tints)].map((tint) => vi.spyOn(tint, 'dispose'));
    highlight.remove();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
