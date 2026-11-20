// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One viewport's looks (inner#1693 design 5.2-5.4, 6.2): pictures judged from headers, held while shown and released
 * when replaced or removed, a stale check leaving no trace, and failures told apart from limits, and which pictures are shown.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshPhysicalMaterial, Texture, type Group, type Material, type Mesh } from 'three';
import { httpRequest, type SceneObject } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import * as modelResources from '@web/spaces/three-d/viewport/model-resources';
import { loadSceneModel } from '@web/spaces/three-d/viewport/model-resources';
import { SceneLookRuntime, lookReportOf, type SceneLookPictures } from '@web/spaces/three-d/viewport/scene-look-runtime';
import type { LookTextureCache } from '@web/spaces/three-d/viewport/look-texture-cache';

vi.mock('@breatic/shared', async (importOriginal) => ({ ...await importOriginal<typeof SharedModule>(), httpRequest: vi.fn() }));
// Pass-through, so a case can give a model its own texture bytes.
vi.mock('@web/spaces/three-d/viewport/model-resources', async (importOriginal) => {
  const actual = await importOriginal<typeof modelResources>();
  return { ...actual, lookModelOf: vi.fn(actual.lookModelOf) };
});
// jsdom never decodes the format probe images.
vi.mock('@web/spaces/three-d/model-texture-format', () => ({ detectTextureFormatSupport: vi.fn(async () => ({ webp: true, avif: true })) }));

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
async function open(fake: FakeCache): Promise<{ runtime: SceneLookRuntime; root: Group; failures: Array<SceneLookPictures | null>; programs: ReturnType<typeof vi.fn>; changed: ReturnType<typeof vi.fn> }> {
  const root = await loadSceneModel(BOX.model as never, new AbortController().signal, vi.fn(), '#969696', IMPORT_LIMITS);
  const failures: Array<SceneLookPictures | null> = [];
  const programs = vi.fn();
  const changed = vi.fn();
  const runtime = new SceneLookRuntime({
    textures: () => fake.cache, limits: () => ({ maxTextureEdge: 8192, maxTextureBytes: 268_435_456, maxPictureHeaderBytes: 12_345_678 }), themeColor: () => '#969696',
    highlightColor: () => '#3b6fd8', onProgramChanged: programs, onChanged: changed, onPictures: (_id, pictures) => failures.push(pictures),
  });
  runtimes.push(runtime);
  return { runtime, root, failures, programs, changed };
}

/** Lets pending promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** The box with a look. */
const withLook = (look: SceneObject['look']): SceneObject => ({ ...BOX, look } as SceneObject);

describe('SceneLookRuntime', () => {
  it('counts the model\u2019s own textures in the object total, so a small picture on a model near its budget is not shown', async () => {
    const fake = fakeCache(async () => SMALL);
    const { runtime, root, failures } = await open(fake);
    const actual = vi.mocked(modelResources.lookModelOf).getMockImplementation()!;
    vi.mocked(modelResources.lookModelOf).mockImplementation((group) => {
      const model = actual(group);
      return model && { ...model, ownBytes: 268_435_456 - 1024 };
    });
    try {
      runtime.sync({ ...BOX, look: { 0: { map: A } } } as SceneObject, root);
      await settle();
      expect(failures.at(-1)).toEqual({ retry: false, over: true, shown: [] });
      expect(fake.acquire).not.toHaveBeenCalled();
      // The panel judges a pick from the same number.
      expect(lookReportOf(root, 8192, '#969696')?.ownBytes).toBe(268_435_456 - 1024);
    } finally {
      vi.mocked(modelResources.lookModelOf).mockImplementation(actual);
    }
  });

  it('recolours every visible tint of the highlight after a theme change', async () => {
    const three = await import('three');
    let colour = '#3b6fd8';
    const runtime = new SceneLookRuntime({
      textures: () => fakeCache(async () => SMALL).cache, limits: () => ({ maxTextureEdge: 8192, maxTextureBytes: 268_435_456, maxPictureHeaderBytes: 12_345_678 }),
      themeColor: () => '#969696', highlightColor: () => colour, onProgramChanged: vi.fn(), onChanged: vi.fn(), onPictures: vi.fn(),
    });
    runtimes.push(runtime);
    const slots = [three.DoubleSide, three.FrontSide].map((side) => {
      const material = new three.MeshStandardMaterial({ side });
      material.userData.lookPart = '0';
      return material;
    });
    const root = new three.Group();
    root.add(new three.Mesh(new three.BoxGeometry(), slots[0]), new three.Mesh(new three.BoxGeometry(), slots[1]));
    runtime.setHighlight('box', root, '0');
    colour = '#d83b6f';
    runtime.restyleHighlight();
    const tints = runtime.overlays().flatMap((overlay) => [(overlay as unknown as { material: unknown }).material].flat() as Array<{ visible: boolean; color: { getHexString: () => string } }>);
    expect(tints.length).toBeGreaterThanOrEqual(2);
    for (const tint of tints.filter((item) => item.visible)) expect(`#${tint.color.getHexString()}`).toBe(colour);
  });

  it('keeps a failed picture failed through look changes and loads it again only on retry', async () => {
    const fake = fakeCache(async () => null);
    const { runtime, root, failures } = await open(fake);
    runtime.sync(withLook({ 0: { map: A } }), root);
    await settle();
    expect(failures.at(-1)).toEqual({ retry: true, over: false, shown: [] });
    expect(fake.size).toHaveBeenCalledTimes(1);
    failures.length = 0;
    for (const roughness of [0.2, 0.4, 0.6]) runtime.sync(withLook({ 0: { map: A, roughness } }), root);
    await settle();
    expect(fake.size).toHaveBeenCalledTimes(1);
    expect(failures.every((pictures) => pictures?.retry)).toBe(true);
    fake.size.mockImplementation(async () => SMALL);
    runtime.retry();
    await settle();
    expect(fake.size).toHaveBeenCalledTimes(2);
    // The picture is shown now, which is what the panel's colour follows.
    expect(failures.at(-1)).toEqual({ retry: false, over: false, shown: [A] });
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

  it('decodes a picture with the edge limit of this device', async () => {
    const fake = fakeCache(async () => ({ width: 1, height: 20000, type: 'png' }));
    const { runtime, root } = await open(fake);
    runtime.sync(withLook({ 0: { map: A } }), root);
    await settle();
    expect(fake.acquire).toHaveBeenCalledWith(A, 8192);
    expect(fake.size).toHaveBeenCalledWith(A, 12_345_678);
  });

  it.each([['loads', true], ['fails', false]] as const)('tells the scene it changed when a picture %s after the look was applied', async (_name, loads) => {
    let finish: () => void = () => undefined;
    const fake = fakeCache(async () => SMALL, () => new Promise<Texture>((resolve, reject) => {
      finish = () => (loads ? resolve(new Texture()) : reject(new Error('decode failed')));
    }));
    const { runtime, root, changed, programs } = await open(fake);
    runtime.sync(withLook({ 0: { map: A } }), root);
    await settle();
    expect(fake.acquire).toHaveBeenCalled();
    const before = changed.mock.calls.length;
    programs.mockClear();
    finish();
    await settle();
    expect(changed.mock.calls.length).toBeGreaterThan(before);
    expect(changed).toHaveBeenLastCalledWith(BOX.id);
    // The box part has no picture of its own, so a loaded one needs a new program and a failed one does not.
    if (loads) expect(programs).toHaveBeenCalledWith(root);
    else expect(programs).not.toHaveBeenCalled();
  });

  it('tells a picture over the limits apart from one that failed to load', async () => {
    const over = fakeCache(async () => ({ width: 9000, height: 9000, type: 'png' }));
    const first = await open(over);
    first.runtime.sync(withLook({ 0: { map: A } }), first.root);
    await settle();
    expect(first.failures.at(-1)).toEqual({ retry: false, over: true, shown: [] });
    expect(over.acquire).not.toHaveBeenCalled();
    const broken = fakeCache(async () => SMALL, async () => { throw new Error('decode failed'); });
    const second = await open(broken);
    second.runtime.sync(withLook({ 0: { map: A } }), second.root);
    await settle();
    expect(second.failures.at(-1)).toEqual({ retry: true, over: false, shown: [] });
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
  it('takes a picture pushed over the budget off its part before releasing it', async () => {
    vi.mocked(httpRequest).mockImplementation(async () => new Response(Uint8Array.from(readFileSync('src/spaces/three-d/viewport/assets/figure.glb'))));
    const C = '11111111-1111-4111-8111-11111111111c';
    const root = await loadSceneModel({ kind: 'builtin', id: 'figure' }, new AbortController().signal, vi.fn(), '#969696', IMPORT_LIMITS);
    /** The first material of a part. */
    const partMaterial = (part: string): Material & { map: Texture | null } => {
      let found: Material | undefined;
      root.traverse((object) => {
        const material = (object as Mesh).material as Material | undefined;
        if (!found && material && !Array.isArray(material) && material.userData.lookPart === part) found = material;
      });
      return found as Material & { map: Texture | null };
    };
    const held = new Map<string, Texture>();
    const shownAtRelease: boolean[] = [];
    const big = { width: 2048, height: 2048, type: 'png' };
    const fake = fakeCache(async (assetId) => (assetId === C ? SMALL : big), (assetId) => {
      // C never finishes loading, so nothing else applies the look meanwhile.
      if (assetId === C) return new Promise<Texture>(() => undefined);
      const texture = new Texture();
      held.set(assetId, texture);
      return Promise.resolve(texture);
    });
    fake.release.mockImplementation((assetId: string) => { if (assetId === A) shownAtRelease.push(partMaterial('1').map?.source === held.get(A)!.source); });
    const runtime = new SceneLookRuntime({
      textures: () => fake.cache, limits: () => ({ maxTextureEdge: 8192, maxTextureBytes: 30 * 1024 * 1024, maxPictureHeaderBytes: 12_345_678 }), themeColor: () => '#969696',
      highlightColor: () => '#3b6fd8', onProgramChanged: vi.fn(), onChanged: vi.fn(), onPictures: vi.fn(),
    });
    runtimes.push(runtime);
    const figure = { ...BOX, id: 'figure', model: { kind: 'builtin', id: 'figure' } } as SceneObject;
    runtime.sync({ ...figure, look: { 1: { map: A } } } as SceneObject, root);
    await settle();
    expect(partMaterial('1').map?.source).toBe(held.get(A)!.source);
    // A part earlier in the list takes the budget, so A is over it now.
    runtime.sync({ ...figure, look: { 0: { map: B }, 1: { map: A }, 2: { map: C } } } as SceneObject, root);
    await settle();
    expect(shownAtRelease).toEqual([false]);
  });
  it('leaves a picture that failed to load out of the total at once', async () => {
    vi.mocked(httpRequest).mockImplementation(async () => new Response(Uint8Array.from(readFileSync('src/spaces/three-d/viewport/assets/figure.glb'))));
    const root = await loadSceneModel({ kind: 'builtin', id: 'figure' }, new AbortController().signal, vi.fn(), '#969696', IMPORT_LIMITS);
    const big = { width: 2048, height: 2048, type: 'png' };
    const fake = fakeCache(async () => big, async (assetId) => {
      if (assetId === A) throw new Error('download failed');
      return new Texture();
    });
    const pictures: Array<SceneLookPictures | null> = [];
    const runtime = new SceneLookRuntime({
      textures: () => fake.cache, limits: () => ({ maxTextureEdge: 8192, maxTextureBytes: 30 * 1024 * 1024, maxPictureHeaderBytes: 12_345_678 }), themeColor: () => '#969696',
      highlightColor: () => '#3b6fd8', onProgramChanged: vi.fn(), onChanged: vi.fn(), onPictures: (_id, value) => pictures.push(value),
    });
    runtimes.push(runtime);
    const figure = { ...BOX, id: 'figure', model: { kind: 'builtin', id: 'figure' } } as SceneObject;
    // Each picture fits the budget alone and the two do not; A comes first, so B is over the total while A counts.
    runtime.sync({ ...figure, look: { 0: { map: A }, 1: { map: B } } } as SceneObject, root);
    await settle();
    await settle();
    expect(pictures.at(-1)).toEqual({ retry: true, over: false, shown: [B] });
  });
});
