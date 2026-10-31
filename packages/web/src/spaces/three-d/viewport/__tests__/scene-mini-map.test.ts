// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, OrthographicCamera, Vector3 } from 'three';
import { ModelResourceCache } from '@web/spaces/three-d/viewport/model-resources';
import { SceneMiniMapRuntime, fitSceneOverview } from '@web/spaces/three-d/viewport/scene-mini-map';
import type { SceneObject } from '@breatic/shared';

const renders: unknown[][] = [];
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio(): void {} setSize(): void {} dispose(): void {}
    render(...args: unknown[]): void { renders.push(args); }
  } };
});
const OBJECT: SceneObject = { id: 'one', model: { kind: 'builtin', id: 'box' }, name: 'Box', position: [40, 8, -30], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 3, 4], locked: false, exists: true };
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); renders.length = 0; document.body.replaceChildren(); });
function model(): Group { const root = new Group(); root.add(new Mesh(new BoxGeometry(2, 4, 8), new MeshStandardMaterial())); return root; }

describe('native scene overview (inner#1724)', () => {
  it('fits transformed world bounds and target with the actual aspect and vertical clipping range', () => {
    const root = model(); root.position.fromArray(OBJECT.position); root.quaternion.fromArray(OBJECT.rotation); root.scale.fromArray(OBJECT.scale); root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root); bounds.expandByPoint(new Vector3(80, -10, -70));
    const camera = new OrthographicCamera(); fitSceneOverview(camera, bounds, 200, 140);
    expect((camera.right - camera.left) / (camera.top - camera.bottom)).toBeCloseTo(200 / 140);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const point = new Vector3(x, y, z).project(camera);
      expect(Math.abs(point.x)).toBeLessThanOrEqual(1); expect(Math.abs(point.y)).toBeLessThanOrEqual(1); expect(Math.abs(point.z)).toBeLessThanOrEqual(1);
    }
  });
  it('leases an independent model after main readiness and releases it before the final main holder', async () => {
    const template = model(); const mesh = template.children[0] as Mesh;
    const dispose = vi.spyOn(mesh.geometry, 'dispose'); const load = vi.fn(async () => template);
    const cache = new ModelResourceCache(load); owners.push(() => cache.dispose());
    const main = cache.acquire(OBJECT.model); const mainRoot = await main.ready;
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 200 }, clientHeight: { value: 140 } });
    const map = new SceneMiniMapRuntime(host, cache, vi.fn()); owners.push(() => map.dispose());
    map.update([OBJECT], new Set(), new Vector3());
    expect(renders.at(-1)?.[0]).toMatchObject({ children: expect.any(Array) });
    map.update([OBJECT], new Set([OBJECT.id]), new Vector3());
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1)); await Promise.resolve(); await Promise.resolve();
    const scene = renders.at(-1)?.[0] as Group;
    const instance = scene.children.find((child) => child.userData.sceneObjectId === OBJECT.id);
    expect(instance).toBeInstanceOf(Group); expect(instance).not.toBe(mainRoot);
    expect(instance?.position.toArray()).toEqual(OBJECT.position);
    map.remove(OBJECT.id); expect(dispose).toHaveBeenCalledTimes(0);
    main.release(); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('withdraws pending instances on close and uses the fitted camera for click navigation', async () => {
    const cache = new ModelResourceCache(async () => model()); owners.push(() => cache.dispose());
    const main = cache.acquire(OBJECT.model); await main.ready;
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 200 }, clientHeight: { value: 140 } });
    const navigate = vi.fn(); const map = new SceneMiniMapRuntime(host, cache, navigate); owners.push(() => map.dispose());
    map.update([OBJECT], new Set([OBJECT.id]), new Vector3(80, 5, -70));
    await Promise.resolve(); await Promise.resolve();
    const canvas = host.querySelector('canvas'); if (!canvas) throw new Error('Expected overview canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 140 } as DOMRect);
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 70 }));
    const camera = renders.at(-1)?.[1] as OrthographicCamera;
    expect(navigate).toHaveBeenCalledWith(expect.closeTo(camera.position.x), expect.closeTo(camera.position.z));
    map.dispose(); await Promise.resolve(); expect(host.children).toHaveLength(0);
  });
  it('renders unchanged projections once and redraws a theme change', () => {
    const cache = new ModelResourceCache(async () => model()); owners.push(() => cache.dispose());
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 200 }, clientHeight: { value: 140 } });
    const map = new SceneMiniMapRuntime(host, cache, vi.fn()); owners.push(() => map.dispose());
    map.update([], new Set(), new Vector3()); const count = renders.length;
    map.update([], new Set(), new Vector3()); map.render();
    expect(renders).toHaveLength(count);
    host.style.setProperty('--color-popover', '#eeeeee'); map.render();
    expect(renders).toHaveLength(count + 1);
  });

});
