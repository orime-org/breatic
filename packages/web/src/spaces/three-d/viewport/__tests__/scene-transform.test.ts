// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneObject } from '@breatic/shared';
import { createTransformGesture, transformPatches, uniformScaleRatio } from '@web/spaces/three-d/viewport/scene-transform';

/** Make an ordinary upright model from the approved scene contract.
 * @throws {never} Never.
 */
function object(id: string, x: number): SceneObject {
  return { id, name: id, model: { kind: 'builtin', id: 'box' }, position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], exists: true, locked: false };
}

describe('scene transform tuples (inner#1689)', () => {
  it('moves the selection as one world-space displacement', () => {
    const gesture = createTransformGesture([object('a', -1), object('b', 1)], 'translate');
    const pivot = new Matrix4().makeTranslation(2, 3, 4);
    expect(transformPatches(gesture, pivot)).toEqual([
      { id: 'a', position: [1, 3, 4] }, { id: 'b', position: [3, 3, 4] },
    ]);
  });

  it('rotates a selection about its shared centre with complete quaternions', () => {
    const gesture = createTransformGesture([object('a', -1), object('b', 1)], 'rotate');
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const patches = transformPatches(gesture, new Matrix4().makeRotationFromQuaternion(turn));
    expect(patches.map((patch) => patch.id)).toEqual(['a', 'b']);
    expect(patches[0].position?.[0]).toBeCloseTo(0);
    expect(patches[0].position?.[1]).toBeCloseTo(-1);
    expect(patches[1].position?.[1]).toBeCloseTo(1);
    expect(patches[0].rotation).toEqual(turn.toArray());
    expect(patches[0].scale).toBeUndefined();
  });

  it('scales multiple objects uniformly and carries their positions', () => {
    const gesture = createTransformGesture([object('a', -1), object('b', 1)], 'scale');
    expect(transformPatches(gesture, new Matrix4().makeScale(2, 2, 2))).toEqual([
      { id: 'a', position: [-2, 0, 0], scale: [2, 2, 2] },
      { id: 'b', position: [2, 0, 0], scale: [2, 2, 2] },
    ]);
  });

  it('keeps one object local-axis scale independent of its rotated axes', () => {
    const model = object('a', 3);
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    model.rotation = turn.toArray();
    const gesture = createTransformGesture([model], 'scale');
    const pivot = new Matrix4().compose(new Vector3(3, 0, 0), turn, new Vector3(2, 3, 4));
    const patches = transformPatches(gesture, pivot);
    expect(patches).toHaveLength(1);
    expect(patches[0].scale?.[0]).toBeCloseTo(2);
    expect(patches[0].scale?.[1]).toBeCloseTo(3);
    expect(patches[0].scale?.[2]).toBeCloseTo(4);
    expect(patches[0].position).toBeUndefined();
    expect(patches[0].rotation).toBeUndefined();
  });

  it('rejects zero, reflected and non-finite transform batches', () => {
    const gesture = createTransformGesture([object('a', 0)], 'scale');
    expect(transformPatches(gesture, new Matrix4().makeScale(0, 1, 1))).toEqual([]);
    expect(transformPatches(gesture, new Matrix4().makeScale(-1, 1, 1))).toEqual([]);
    expect(uniformScaleRatio(Infinity, 0, 0.006)).toBeNull();
    expect(uniformScaleRatio(-Infinity, 0, 0.006)).toBeNull();
  });

  it('preserves complete finite position tuples under arbitrary displacements', () => {
    fc.assert(fc.property(
      fc.tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 })),
      ([x, y, z]) => {
        const gesture = createTransformGesture([object('a', 0)], 'translate');
        expect(transformPatches(gesture, new Matrix4().makeTranslation(x, y, z))).toEqual([{ id: 'a', position: [x, y, z] }]);
      },
    ));
  });

  it('uniform scale stays positive and reverses its screen displacement', () => {
    fc.assert(fc.property(fc.integer({ min: -500, max: 500 }), (pixels) => {
      const ratio = uniformScaleRatio(pixels, 0, 0.006);
      const inverse = uniformScaleRatio(-pixels, 0, 0.006);
      expect(ratio).toBeGreaterThan(0);
      expect((ratio ?? 0) * (inverse ?? 0)).toBeCloseTo(1);
    }));
  });
});
