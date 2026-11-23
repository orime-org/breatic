// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The viewport's part reports and shader pre-compiles for looks (inner#1693 design 5.1, 5.2), on a real built-in box.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Texture, type Object3D, type Scene, type WebGLRenderer } from 'three';
import type { SceneObject } from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { SceneViewportRuntime } from '@web/spaces/three-d/viewport/scene-viewport-runtime';
import type { SceneViewportRuntimeProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

const compiles: Array<{ scene: Object3D; target: Scene | null | undefined; types: string[] }> = [];
const steps: string[] = [];
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    capabilities = { maxTextures: 16, maxTextureSize: 4096 };
    info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
    setPixelRatio(): void {} setSize(): void {} render(): void {} dispose(): void {} getPixelRatio(): number { return 1; }
    compile(scene: Object3D, _camera: unknown, target?: Scene | null): void {
      const types: string[] = [];
      scene.traverse((child) => { const material = (child as { material?: { type: string } }).material; if (material) types.push(material.type); });
      compiles.push({ scene, target, types });
      steps.push('compile');
    }
    getContext(): unknown { return { isContextLost: () => false, getParameter: () => 'test', RENDERER: 0, VERSION: 0 }; }
  } };
});

const BOX: SceneObject = { id: 'box', model: { kind: 'builtin', id: 'box' }, name: 'Box', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); compiles.length = 0; steps.length = 0; });

/** Props for a scene holding one built-in box. */
function props(extra: Partial<SceneViewportRuntimeProps> = {}): SceneViewportRuntimeProps {
  return {
    objects: [BOX], selectedIds: [], mode: 'translate', readOnly: false,
    view: { position: [5, 5, 5], target: [0, 0, 0] }, focusRevision: 0, cancelRevision: 0, remotePeers: [],
    scaleSensitivity: 0.006, importLimits: IMPORT_LIMITS,
    jointMode: false, selectedJoint: null, onJointSelect: vi.fn(), onSkeletonState: vi.fn(),
    onSelect: vi.fn(), onGestureStart: vi.fn(() => true), onGestureChange: vi.fn(), onGestureEnd: vi.fn(), onViewChange: vi.fn(), onError: vi.fn(),
    onModelStateChange: vi.fn(), resolveAsset: vi.fn(), onLookReport: vi.fn(),
    ...extra,
  } as SceneViewportRuntimeProps;
}

/** A runtime on a host whose theme colour is the given grey, once the box has loaded. */
async function open(initial: SceneViewportRuntimeProps, grey: string): Promise<{ runtime: SceneViewportRuntime; host: HTMLDivElement }> {
  const host = document.createElement('div'); document.body.append(host);
  host.style.setProperty('--color-muted-foreground', grey);
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  const runtime = new SceneViewportRuntime(host, initial); owners.push(() => runtime.dispose());
  await vi.waitFor(() => expect(initial.onModelStateChange).toHaveBeenCalledWith('box', 'ready'));
  return { runtime, host };
}

/** The last ready report for the box. */
function lastReport(onLookReport: unknown): { parts: Array<{ key: string; name: string | null; color: string }> } {
  const calls = vi.mocked(onLookReport as (id: string, report: unknown) => void).mock.calls.filter(([, report]) => typeof report === 'object');
  return calls.at(-1)?.[1] as { parts: Array<{ key: string; name: string | null; color: string }> };
}

describe('part reports (inner#1693 design 3.1, 5.1)', () => {
  it('names built-in parts by number and reports their colour from the current theme, again after a theme change', async () => {
    const initial = props();
    const { runtime, host } = await open(initial, '#969696');
    expect(lastReport(initial.onLookReport).parts).toEqual([expect.objectContaining({ key: '0', name: null, color: '#969696' })]);
    const reports = vi.mocked(initial.onLookReport!).mock.calls.length;
    runtime.update(props({ onLookReport: initial.onLookReport, onModelStateChange: initial.onModelStateChange }));
    expect(vi.mocked(initial.onLookReport!).mock.calls.length).toBe(reports);
    host.style.setProperty('--color-muted-foreground', '#5f5f5f');
    (runtime as unknown as { onThemeChange: () => void }).onThemeChange();
    expect(lastReport(initial.onLookReport).parts).toEqual([expect.objectContaining({ key: '0', color: '#5f5f5f' })]);
  });
});

describe('pre-compiling a changed part (inner#1693 design 5.2)', () => {
  it('compiles the object for the scene it draws in, with its lights and environment', async () => {
    const initial = props();
    const { runtime } = await open(initial, '#969696');
    const scene = (runtime as unknown as { scene: Scene }).scene;
    // The load compiled the box for the scene too, before it joined it.
    expect(compiles.some((call) => call.scene !== scene)).toBe(true);
    for (const call of compiles) expect(call.target).toBe(scene);
    compiles.length = 0;
    runtime.update(props({ objects: [{ ...BOX, look: { 0: { transmission: 1 } } }], onLookReport: initial.onLookReport, onModelStateChange: initial.onModelStateChange }));
    expect(compiles.length).toBeGreaterThan(0);
    for (const call of compiles) expect(call.target).toBe(scene);
  });
});

describe('compiling a loading object (inner#1693 design 5.2)', () => {
  it('compiles it once, with its look already on', async () => {
    const initial = props({ objects: [{ ...BOX, look: { 0: { transmission: 1 } } }] });
    const { runtime } = await open(initial, '#969696');
    const scene = (runtime as unknown as { scene: Scene }).scene;
    const loads = compiles.filter((call) => call.scene !== scene);
    expect(loads).toHaveLength(1);
    expect(loads[0]!.types).toEqual(['MeshPhysicalMaterial']);
  });
});

describe('releasing part pictures (inner#1693 design 5.3)', () => {
  it('releases a deleted object\'s pictures', async () => {
    const picture = '11111111-1111-4111-8111-11111111111a';
    const texture = new Texture();
    const cache = { size: vi.fn(async () => ({ width: 64, height: 64, type: 'png' })), acquire: vi.fn(async () => texture), release: vi.fn() };
    const initial = props({ objects: [{ ...BOX, look: { 0: { map: picture } } }], lookTextures: cache as never });
    const { runtime } = await open(initial, '#969696');
    await vi.waitFor(() => expect(cache.acquire).toHaveBeenCalledWith(picture, 4096));
    expect(cache.size).toHaveBeenCalledWith(picture, IMPORT_LIMITS.maxPictureHeaderBytes);
    // The decoded picture is held once its acquire settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.update(props({ objects: [], lookTextures: cache as never, onLookReport: initial.onLookReport, onModelStateChange: initial.onModelStateChange }));
    expect(cache.release).toHaveBeenCalledWith(picture, texture);
  });
});

describe('a part picture that loads after the look applied (inner#1693 design 5.2, 5.4)', () => {
  it('marks the monitors stale and compiles the object for its scene before recounting the lights', async () => {
    const picture = '11111111-1111-4111-8111-11111111111a';
    let finish: () => void = () => undefined;
    const cache = { size: vi.fn(async () => ({ width: 64, height: 64, type: 'png' })), release: vi.fn(),
      acquire: vi.fn(() => new Promise<Texture>((resolve) => { finish = () => resolve(new Texture()); })) };
    const initial = props({ objects: [{ ...BOX, look: { 0: { map: picture } } }], lookTextures: cache as never });
    const { runtime } = await open(initial, '#969696');
    await vi.waitFor(() => expect(cache.acquire).toHaveBeenCalled());
    const scene = (runtime as unknown as { scene: Scene }).scene;
    const internals = runtime as unknown as { monitorEvent: (event: { type: string }) => void; syncLights: () => void };
    const monitor = vi.spyOn(internals, 'monitorEvent');
    const lights = internals.syncLights.bind(runtime);
    vi.spyOn(internals, 'syncLights').mockImplementation(() => { steps.push('lights'); lights(); });
    compiles.length = 0; steps.length = 0;
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(monitor.mock.calls.filter(([event]) => event.type === 'changed')).toHaveLength(1);
    expect(compiles).toHaveLength(1);
    expect(compiles[0]!.target).toBe(scene);
    expect(steps.slice(0, 2)).toEqual(['compile', 'lights']);
  });
});

describe('shadows after a part picture settles (inner#1693 design 5.2)', () => {
  it('redraws the shadow maps once a picture that was loading settles, as its cut-out can change the shadow', async () => {
    const picture = '11111111-1111-4111-8111-11111111111a';
    let fail: () => void = () => undefined;
    const cache = { size: vi.fn(async () => ({ width: 64, height: 64, type: 'png' })), release: vi.fn(),
      acquire: vi.fn(() => new Promise<Texture>((_resolve, reject) => { fail = () => reject(new Error('download failed')); })) };
    const { runtime } = await open(props({ objects: [{ ...BOX, look: { 0: { map: picture } } }], lookTextures: cache as never }), '#969696');
    await vi.waitFor(() => expect(cache.acquire).toHaveBeenCalled());
    const { renderer } = runtime as unknown as { renderer: WebGLRenderer };
    renderer.shadowMap.needsUpdate = false;
    fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderer.shadowMap.needsUpdate).toBe(true);
  });
});

describe('a restored GPU context (inner#1693 design 5.7)', () => {
  it('redraws the shadows, since a restore empties GPU-made shadow maps, and stops listening once closed', async () => {
    const initial = props();
    const { runtime } = await open(initial, '#969696');
    const { scene, renderer } = runtime as unknown as { scene: Scene; renderer: WebGLRenderer };
    expect(scene.environment).toBeNull();
    renderer.shadowMap.needsUpdate = false;
    renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.shadowMap.needsUpdate).toBe(true);
    runtime.dispose();
    renderer.shadowMap.needsUpdate = false;
    renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
    expect(renderer.shadowMap.needsUpdate).toBe(false);
  });
});

describe('the parts the page exposes for inspection (inner#1693)', () => {
  it('reads an object\'s drawn parts again only when a look applied to that object', async () => {
    const OTHER: SceneObject = { ...BOX, id: 'other', position: [3, 0, 0] };
    const initial = props({ objects: [BOX, OTHER] });
    const { runtime } = await open(initial, '#969696');
    await vi.waitFor(() => expect(initial.onModelStateChange).toHaveBeenCalledWith('other', 'ready'));
    const { items } = runtime as unknown as { items: Map<string, { root: Object3D }> };
    const box = vi.spyOn(items.get('box')!.root, 'traverse');
    const other = vi.spyOn(items.get('other')!.root, 'traverse');
    const keep = { onLookReport: initial.onLookReport, onModelStateChange: initial.onModelStateChange };
    runtime.update(props({ objects: [{ ...BOX, position: [1, 0, 0] }, OTHER], ...keep }));
    expect(box).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    runtime.update(props({ objects: [{ ...BOX, position: [1, 0, 0], look: { 0: { color: '#ff0000' } } }, OTHER], ...keep }));
    expect(box).toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it('reads them when a look applies, not on every orbit frame', async () => {
    const initial = props();
    const { runtime } = await open(initial, '#969696');
    const { orbit, items } = runtime as unknown as { orbit: { dispatchEvent: (event: { type: 'change' }) => void }; items: Map<string, { root: Object3D }> };
    const root = items.get('box')!.root;
    const traverse = vi.spyOn(root, 'traverse');
    orbit.dispatchEvent({ type: 'change' });
    orbit.dispatchEvent({ type: 'change' });
    expect(traverse).not.toHaveBeenCalled();
    const canvas = document.querySelector('canvas')!;
    const drawn = (): unknown => (JSON.parse(canvas.dataset.objects ?? '[]') as Array<{ parts: Record<string, { type: string }> }>)[0]?.parts['0']?.type;
    expect(drawn()).toBe('MeshStandardMaterial');
    runtime.update(props({ objects: [{ ...BOX, look: { 0: { transmission: 1 } } }], onLookReport: initial.onLookReport, onModelStateChange: initial.onModelStateChange }));
    expect(drawn()).toBe('MeshPhysicalMaterial');
  });
});

describe('Retry (inner#1693 design 6.2)', () => {
  it('loads a part picture again that failed to load, and shows it', async () => {
    const picture = '11111111-1111-4111-8111-11111111111a';
    const texture = new Texture();
    const cache = { size: vi.fn(async () => ({ width: 64, height: 64, type: 'png' })), release: vi.fn(),
      acquire: vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(texture) };
    const onLookPictures = vi.fn();
    const initial = props({ objects: [{ ...BOX, look: { 0: { map: picture } } }], lookTextures: cache as never, onLookPictures } as Partial<SceneViewportRuntimeProps>);
    const { runtime } = await open(initial, '#969696');
    await vi.waitFor(() => expect(onLookPictures).toHaveBeenLastCalledWith(BOX.id, expect.objectContaining({ retry: true })));
    runtime.update({ ...initial, modelRetryRevision: 1 });
    await vi.waitFor(() => expect(cache.acquire).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(onLookPictures).toHaveBeenLastCalledWith(BOX.id, { retry: false, over: false, shown: [picture] }));
    const maps: Array<Texture | null> = [];
    (runtime as unknown as { scene: Scene }).scene.traverse((object) => {
      const material = (object as { material?: { userData: { lookPart?: string }; map?: Texture | null } }).material;
      if (material && !Array.isArray(material) && material.userData.lookPart === '0') maps.push(material.map ?? null);
    });
    expect(maps.length).toBeGreaterThan(0);
    expect(maps.every((map) => map?.source === texture.source)).toBe(true);
  });

  it('loads again a model that failed to arrive, never one whose content was refused', async () => {
    const REFUSED = '22222222-2222-4222-8222-22222222222a';
    const LOST = '22222222-2222-4222-8222-22222222222b';
    const resolveAsset = vi.fn(async (assetId: string) => {
      if (assetId === REFUSED) throw new ModelImportError('invalid', 'refused content', { detail: 'model.glb' });
      throw new Error('network');
    });
    const objects = [REFUSED, LOST].map((assetId) => ({ ...BOX, id: assetId, model: { kind: 'asset', assetId } }) as SceneObject);
    const initial = props({ objects, resolveAsset } as Partial<SceneViewportRuntimeProps>);
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    const runtime = new SceneViewportRuntime(host, initial); owners.push(() => runtime.dispose());
    await vi.waitFor(() => expect(vi.mocked(initial.onModelStateChange!).mock.calls.filter(([, state]) => state === 'failed')).toHaveLength(2));
    const calls = (assetId: string): number => resolveAsset.mock.calls.filter(([id]) => id === assetId).length;
    const refused = calls(REFUSED);
    const lost = calls(LOST);
    runtime.update({ ...initial, modelRetryRevision: 1 });
    await vi.waitFor(() => expect(calls(LOST)).toBeGreaterThan(lost));
    expect(calls(REFUSED)).toBe(refused);
  });
});
