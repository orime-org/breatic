// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { SceneObject } from '@breatic/shared';
import { ModelResourceCache } from '@web/spaces/three-d/viewport/model-resources';
import { SceneMiniMapRuntime } from '@web/spaces/three-d/viewport/scene-mini-map';
import { applyPose } from '@web/spaces/three-d/viewport/pose-rig';

const renders: unknown[][] = [];
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio(): void {} setSize(): void {} dispose(): void {}
    render(...args: unknown[]): void { renders.push(args); }
  } };
});
// applyPose is the one entry that poses an instance (design 3.2); the overview must go through it.
vi.mock('@web/spaces/three-d/viewport/pose-rig', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/spaces/three-d/viewport/pose-rig')>(), applyPose: vi.fn(),
}));

const LYING = { 'h:hips': [0.7071068, 0, 0, 0.7071068], 't:hips': [0, -0.8, 0] } as const;
const WAVING = { 'h:rightUpperArm': [0, 0, -0.7071068, 0.7071068] } as const;
const OBJECT: SceneObject = { id: 'one', model: { kind: 'builtin', id: 'figure' }, name: 'Figure', position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, pose: LYING };
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); renders.length = 0; document.body.replaceChildren(); vi.mocked(applyPose).mockClear(); });
function model(): Group { const root = new Group(); root.add(new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial())); return root; }

describe('overview shows each object\'s document pose (inner#1692)', () => {
  it('poses its own instance with the document pose and follows pose changes, including a reset', async () => {
    const cache = new ModelResourceCache(async () => model()); owners.push(() => cache.dispose());
    const main = cache.acquire(OBJECT.model); const mainRoot = await main.ready; owners.push(() => main.release());
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 200 }, clientHeight: { value: 140 } });
    const map = new SceneMiniMapRuntime(host, cache, vi.fn()); owners.push(() => map.dispose());
    map.update([OBJECT], new Set([OBJECT.id]), new Vector3());
    await vi.waitFor(() => expect(renders.at(-1)?.[0]).toBeDefined());
    let instance: unknown;
    await vi.waitFor(() => {
      instance = (renders.at(-1)?.[0] as Group).children.find((child) => child.userData.sceneObjectId === OBJECT.id);
      expect(instance).toBeInstanceOf(Group);
    });
    expect(instance).not.toBe(mainRoot);
    expect(applyPose).toHaveBeenLastCalledWith(instance, LYING);

    map.update([{ ...OBJECT, pose: WAVING }], new Set([OBJECT.id]), new Vector3());
    expect(applyPose).toHaveBeenLastCalledWith(instance, WAVING);

    const { pose: _pose, ...rest } = OBJECT;
    map.update([rest], new Set([OBJECT.id]), new Vector3());
    expect(vi.mocked(applyPose).mock.lastCall?.[0]).toBe(instance);
    // A reset is the rest pose, whether written as no pose or an empty one.
    expect(vi.mocked(applyPose).mock.lastCall?.[1] ?? {}).toEqual({});
  });
});
