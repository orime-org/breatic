// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { Bone, BoxGeometry, Group, Mesh, MeshStandardMaterial, Skeleton, SkinnedMesh, Texture } from 'three';
import { ModelResourceCache } from '@web/spaces/three-d/viewport/model-resources';

/** Make a real Three model whose ownership can be inspected.
 * @throws {never} Never.
 */
function model(): Group {
  const root = new Group();
  const material = new MeshStandardMaterial({ map: new Texture() });
  root.add(new Mesh(new BoxGeometry(), material));
  return root;
}

/** Get the ordinary mesh in the real model fixture.
 * @throws {Error} When the fixture does not contain a mesh.
 */
function mesh(root: Group): Mesh<BoxGeometry, MeshStandardMaterial> {
  const found = root.children[0];
  if (!(found instanceof Mesh)) throw new Error('Fixture has no mesh');
  return found as Mesh<BoxGeometry, MeshStandardMaterial>;
}

describe('scene model resource ownership (inner#1689)', () => {
  it('shares immutable geometry and texture, clones editable material, and releases at the last holder', async () => {
    const root = model();
    const geometryDispose = vi.spyOn(mesh(root).geometry, 'dispose');
    const texture = mesh(root).material.map;
    if (!texture) throw new Error('Fixture has no texture');
    const textureDispose = vi.spyOn(texture, 'dispose');
    const templateDispose = vi.spyOn(mesh(root).material, 'dispose');
    const load = vi.fn().mockResolvedValue(root);
    const cache = new ModelResourceCache(load);
    const a = cache.acquire({ kind: 'asset', assetId: 'model' });
    const b = cache.acquire({ kind: 'asset', assetId: 'model' });
    const [first, second] = await Promise.all([a.ready, b.ready]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(mesh(first).geometry).toBe(mesh(second).geometry);
    expect(mesh(first).material.map).toBe(mesh(second).material.map);
    expect(mesh(first).material).not.toBe(mesh(second).material);
    mesh(first).material.color.setRGB(1, 0, 0);
    expect(mesh(second).material.color.getHex()).toBe(0xffffff);
    const firstDispose = vi.spyOn(mesh(first).material, 'dispose');
    a.release();
    a.release();
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(geometryDispose).toHaveBeenCalledTimes(0);
    b.release();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(templateDispose).toHaveBeenCalledTimes(1);
  });

  it('releases a late model instead of attaching it after its holder left', async () => {
    const root = model();
    const dispose = vi.spyOn(mesh(root).geometry, 'dispose');
    let complete: (value: Group) => void = () => { throw new Error('Not started'); };
    const cache = new ModelResourceCache(() => new Promise<Group>((resolve) => { complete = resolve; }));
    const lease = cache.acquire({ kind: 'asset', assetId: 'late' });
    const rejected = expect(lease.ready).rejects.toMatchObject({ name: 'AbortError' });
    lease.release();
    complete(root);
    await rejected;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('gives copies independent skeletons and editable bone transforms', async () => {
    const root = new Group();
    const bone = new Bone();
    const skinned = new SkinnedMesh(new BoxGeometry(), new MeshStandardMaterial());
    skinned.add(bone);
    skinned.bind(new Skeleton([bone]));
    root.add(skinned);
    const cache = new ModelResourceCache(async () => root);
    const a = cache.acquire({ kind: 'asset', assetId: 'rig' });
    const b = cache.acquire({ kind: 'asset', assetId: 'rig' });
    const [first, second] = await Promise.all([a.ready, b.ready]);
    const firstSkin = first.children[0] as SkinnedMesh;
    const secondSkin = second.children[0] as SkinnedMesh;
    expect(firstSkin.skeleton).not.toBe(secondSkin.skeleton);
    firstSkin.skeleton.bones[0].position.x = 2;
    expect(secondSkin.skeleton.bones[0].position.x).toBe(0);
    a.release();
    b.release();
  });

  it('forgets a failed template when its holder releases and can load it again', async () => {
    const failure = new Error('Could not load');
    const root = model();
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(root);
    const cache = new ModelResourceCache(load);
    const failed = cache.acquire({ kind: 'asset', assetId: 'retry' });
    await expect(failed.ready).rejects.toBe(failure);
    failed.release();
    const retried = cache.acquire({ kind: 'asset', assetId: 'retry' });
    const instance = await retried.ready;
    expect(instance.children).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
    cache.dispose();
    retried.release();
  });

});
