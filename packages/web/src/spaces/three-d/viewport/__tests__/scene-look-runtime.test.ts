// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One viewport's looks (inner#1693 design 5.2-5.4, 6.2): pictures judged from headers, held while shown and released
 * when replaced or removed, a stale check leaving no trace, and failures told apart from limits.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshPhysicalMaterial, Texture, type Group, type Mesh } from 'three';
import type { SceneObject } from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { loadSceneModel } from '@web/spaces/three-d/viewport/model-resources';
import { SceneLookRuntime, type SceneLookFailure } from '@web/spaces/three-d/viewport/scene-look-runtime';
import type { LookTextureCache } from '@web/spaces/three-d/viewport/look-texture-cache';

const A = '11111111-1111-4111-8111-11111111111a';
const B = '11111111-1111-4111-8111-11111111111b';
const BOX: SceneObject = { id: 'box', model: { kind: 'builtin', id: 'box' }, name: 'Box', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const SMALL = { width: 64, height: 64, type: 'png' };

interface FakeCache {
  cache: LookTextureCache;
  size: ReturnType<typeof vi.fn>;
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

/**
 * A picture cache whose answers the test sets.
 * @param sizeOf - The header answer per picture.
 * @param acquireOf - The decode per picture.
 * @returns The cache and its spies.
 */
function fakeCache(sizeOf: (assetId: string) => Promise<typeof SMALL | null>, acquireOf: (assetId: string) => Promise<Texture> = async () => new Texture()): FakeCache {
  const size = vi.fn(sizeOf);
  const acquire = vi.fn(acquireOf);
  const release = vi.fn();
  return { cache: { size, acquire, release } as unknown as LookTextureCache, size, acquire, release };
}

const runtimes: SceneLookRuntime[] = [];
afterEach(() => { runtimes.splice(0).forEach((runtime) => runtime.dispose()); });

/** A runtime over a fake cache, with a loaded built-in box. */
async function open(fake: FakeCache): Promise<{ runtime: SceneLookRuntime; root: Group; failures: Array<SceneLookFailure | null>; programs: ReturnType<typeof vi.fn> }> {
  const root = await loadSceneModel(BOX.model as never, new AbortController().signal, vi.fn(), '#969696', IMPORT_LIMITS);
  const failures: Array<SceneLookFailure | null> = [];
  const programs = vi.fn();
  const runtime = new SceneLookRuntime({
    textures: () => fake.cache, limits: () => ({ maxTextureEdge: 8192, maxTextureBytes: 268_435_456 }), themeColor: () => '#969696',
    highlightColor: () => '#3b6fd8', onProgramChanged: programs, onChanged: vi.fn(), onFailure: (_id, failure) => failures.push(failure),
  });
  runtimes.push(runtime);
  return { runtime, root, failures, programs };
}

/** Lets pending promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** The box with a look. */
const withLook = (look: SceneObject['look']): SceneObject => ({ ...BOX, look } as SceneObject);

describe('SceneLookRuntime', () => {
  it('keeps a failed picture failed through look changes and loads it again only on retry', async () => {
    const fake = fakeCache(async () => null);
    const { runtime, root, failures } = await open(fake);
    runtime.sync(withLook({ 0: { map: A } }), root);
    await settle();
    expect(failures.at(-1)).toEqual({ retry: true, over: false });
    expect(fake.size).toHaveBeenCalledTimes(1);
    failures.length = 0;
    for (const roughness of [0.2, 0.4, 0.6]) runtime.sync(withLook({ 0: { map: A, roughness } }), root);
    await settle();
    expect(fake.size).toHaveBeenCalledTimes(1);
    expect(failures).not.toContain(null);
    fake.size.mockImplementation(async () => SMALL);
    runtime.retry();
    await settle();
    expect(fake.size).toHaveBeenCalledTimes(2);
    expect(failures.at(-1)).toBeNull();
  });

  it('releases every picture it held once replaced or removed', async () => {
    const fake = fakeCache(async () => SMALL);
    const { runtime, root } = await open(fake);
    runtime.sync(withLook({ 0: { map: A } }), root);
    await settle();
    runtime.sync(withLook({ 0: { map: B } }), root);
    await settle();
    expect(fake.release).toHaveBeenCalledWith(A, expect.any(Texture));
    runtime.remove(BOX.id);
    expect(fake.acquire.mock.calls.map(([id]) => id).sort()).toEqual(fake.release.mock.calls.map(([id]) => id).sort());
  });

  it('shows the latest look when an older check finishes after a newer one', async () => {
    let releaseA: (size: typeof SMALL) => void = () => undefined;
    const fake = fakeCache((assetId) => (assetId === A ? new Promise((resolve) => { releaseA = resolve; }) : Promise.resolve(SMALL)));
    const { runtime, root } = await open(fake);
    runtime.sync(withLook({ 0: { map: A } }), root);
    runtime.sync(withLook({ 0: { map: B } }), root);
    await settle();
    releaseA(SMALL);
    await settle();
    expect(fake.acquire.mock.calls.map(([id]) => id)).toEqual([B]);
    const material = (root.children[0] as Mesh).material as unknown as { map: Texture | null };
    expect(material.map).not.toBeNull();
  });

  it('tells a picture over the limits apart from one that failed to load', async () => {
    const over = fakeCache(async () => ({ width: 9000, height: 9000, type: 'png' }));
    const first = await open(over);
    first.runtime.sync(withLook({ 0: { map: A } }), first.root);
    await settle();
    expect(first.failures.at(-1)).toEqual({ retry: false, over: true });
    expect(over.acquire).not.toHaveBeenCalled();
    const broken = fakeCache(async () => SMALL, async () => { throw new Error('decode failed'); });
    const second = await open(broken);
    second.runtime.sync(withLook({ 0: { map: A } }), second.root);
    await settle();
    expect(second.failures.at(-1)).toEqual({ retry: true, over: false });
  });

  it('asks for a compile when a part changes shader class', async () => {
    const fake = fakeCache(async () => SMALL);
    const { runtime, root, programs } = await open(fake);
    runtime.sync(BOX, root);
    programs.mockClear();
    runtime.sync(withLook({ 0: { transmission: 1 } }), root);
    expect((root.children[0] as Mesh).material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(programs).toHaveBeenCalledWith(root);
  });
});
