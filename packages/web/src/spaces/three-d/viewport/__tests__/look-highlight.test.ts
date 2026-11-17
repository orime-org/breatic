// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Highlighting a selected part and picking a part from a hit (inner#1693 design 5.5, 5.6).
 */

import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Intersection } from 'three';
import { describe, expect, it } from 'vitest';

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
    const decide = exported<(input: { poseTarget: boolean; shift: boolean; hitId: string | null; onlySelected: string | null; part: string | null }) =>
      { kind: 'joint' } | { kind: 'select'; id: string | null; additive: boolean } | { kind: 'part'; part: string }>('decideScenePick');
    expect(decide({ poseTarget: true, shift: false, hitId: 'a', onlySelected: 'a', part: '0' })).toEqual({ kind: 'joint' });
    expect(decide({ poseTarget: false, shift: true, hitId: 'a', onlySelected: 'a', part: '0' })).toEqual({ kind: 'select', id: 'a', additive: true });
    expect(decide({ poseTarget: false, shift: false, hitId: 'a', onlySelected: 'a', part: '0' })).toEqual({ kind: 'part', part: '0' });
    expect(decide({ poseTarget: false, shift: false, hitId: 'b', onlySelected: 'a', part: '0' })).toEqual({ kind: 'select', id: 'b', additive: false });
    expect(decide({ poseTarget: false, shift: false, hitId: null, onlySelected: 'a', part: null })).toEqual({ kind: 'select', id: null, additive: false });
  });
});
