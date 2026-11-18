// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The viewport's part reports and shader pre-compiles for looks (inner#1693 design 5.1, 5.2), on a real built-in box.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Object3D, Scene, Texture, WebGLRenderer } from 'three';
import type { SceneObject } from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { createSceneEnvironment } from '@web/spaces/three-d/viewport/scene-environment';
import { SceneViewportRuntime } from '@web/spaces/three-d/viewport/scene-viewport-runtime';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

const compiles: Array<{ scene: Object3D; target: Scene | null | undefined }> = [];
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    capabilities = { maxTextures: 16, maxTextureSize: 4096 };
    info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
    setPixelRatio(): void {} setSize(): void {} render(): void {} dispose(): void {} getPixelRatio(): number { return 1; }
    compile(scene: Object3D, _camera: unknown, target?: Scene | null): void { compiles.push({ scene, target }); }
    getContext(): unknown { return { isContextLost: () => false, getParameter: () => 'test', RENDERER: 0, VERSION: 0 }; }
  } };
});
vi.mock('@web/spaces/three-d/viewport/scene-environment', async () => {
  const { Texture } = await import('three');
  return { SCENE_ENVIRONMENT_INTENSITY: 0.4, createSceneEnvironment: vi.fn(() => new Texture()) };
});

const BOX: SceneObject = { id: 'box', model: { kind: 'builtin', id: 'box' }, name: 'Box', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); compiles.length = 0; });

/** Props for a scene holding one built-in box. */
function props(extra: Partial<SceneViewportProps> = {}): SceneViewportProps {
  return {
    objects: [BOX], selectedIds: [], mode: 'translate', readOnly: false,
    view: { position: [5, 5, 5], target: [0, 0, 0] }, focusRevision: 0, cancelRevision: 0, remotePeers: [],
    scaleSensitivity: 0.006, importLimits: IMPORT_LIMITS,
    jointMode: false, selectedJoint: null, onJointSelect: vi.fn(), onSkeletonState: vi.fn(),
    onSelect: vi.fn(), onGestureStart: vi.fn(() => true), onGestureChange: vi.fn(), onGestureEnd: vi.fn(), onViewChange: vi.fn(), onError: vi.fn(),
    onModelStateChange: vi.fn(), resolveAsset: vi.fn(), onLookReport: vi.fn(),
    ...extra,
  } as SceneViewportProps;
}

/** A runtime on a host whose theme colour is the given grey, once the box has loaded. */
async function open(initial: SceneViewportProps, grey: string): Promise<{ runtime: SceneViewportRuntime; host: HTMLDivElement }> {
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
    compiles.length = 0;
    runtime.update(props({ objects: [{ ...BOX, look: { 0: { transmission: 1 } } }], onLookReport: initial.onLookReport, onModelStateChange: initial.onModelStateChange }));
    expect(compiles.length).toBeGreaterThan(0);
    const scene = (runtime as unknown as { scene: Scene }).scene;
    for (const call of compiles) expect(call.target).toBe(scene);
  });
});

describe('a restored GPU context (inner#1693 design 5.7)', () => {
  it('generates the environment again and redraws the shadows, since a restore empties GPU-made textures', async () => {
    const initial = props();
    const { runtime } = await open(initial, '#969696');
    const { scene, renderer } = runtime as unknown as { scene: Scene; renderer: WebGLRenderer };
    const before = scene.environment as Texture;
    const dispose = vi.spyOn(before, 'dispose');
    renderer.shadowMap.needsUpdate = false;
    renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
    expect(vi.mocked(createSceneEnvironment)).toHaveBeenLastCalledWith(renderer);
    expect(scene.environment).not.toBe(before);
    expect(dispose).toHaveBeenCalled();
    expect(renderer.shadowMap.needsUpdate).toBe(true);
    const restored = scene.environment as Texture;
    const disposeRestored = vi.spyOn(restored, 'dispose');
    runtime.dispose();
    expect(disposeRestored).toHaveBeenCalled();
    const calls = vi.mocked(createSceneEnvironment).mock.calls.length;
    renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
    expect(vi.mocked(createSceneEnvironment).mock.calls.length).toBe(calls);
  });
});

describe('the parts the page exposes for inspection (inner#1693)', () => {
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
