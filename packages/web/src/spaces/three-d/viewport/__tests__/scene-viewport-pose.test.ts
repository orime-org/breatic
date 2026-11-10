// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SceneObject } from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { applyPose } from '@web/spaces/three-d/viewport/pose-rig';
import { SceneViewportRuntime } from '@web/spaces/three-d/viewport/scene-viewport-runtime';
import type { SceneRemotePeer, SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

// Tests run from packages/web; the bytes are the committed asset the browser fetches.
const FIGURE_PATH = 'src/spaces/three-d/viewport/assets/figure.glb';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio(): void {} setSize(): void {} render(): void {} dispose(): void {}
    info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
    getContext(): unknown { return { isContextLost: () => false, getParameter: () => 'test', RENDERER: 0, VERSION: 0 }; }
  } };
});
// The built-in figure, parsed once per load as the browser would after fetching it.
vi.mock('@web/spaces/three-d/viewport/model-resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/spaces/three-d/viewport/model-resources')>(),
  loadSceneModel: vi.fn(async () => {
    const bytes = await new Response(Uint8Array.from(readFileSync(FIGURE_PATH))).arrayBuffer();
    return (await new GLTFLoader().parseAsync(bytes, '')).scene;
  }),
}));
// applyPose is the one entry that poses an instance (design 3.2); spy on it and keep its effect.
vi.mock('@web/spaces/three-d/viewport/pose-rig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/three-d/viewport/pose-rig')>();
  return { ...actual, applyPose: vi.fn(actual.applyPose) };
});

const LYING = { 'h:hips': [-0.7071068, 0, 0, 0.7071068], 't:hips': [0, -0.86, 0] } as const;
const WAVING = { 'h:rightUpperArm': [0, 0, -0.7071068, 0.7071068] } as const;
const FIGURE: SceneObject = { id: 'one', model: { kind: 'builtin', id: 'figure' }, name: 'Figure', position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, pose: LYING };
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); vi.mocked(applyPose).mockClear(); });

/**
 * Viewport props with one figure and the given collaborators.
 * @param remotePeers - Collaborators.
 * @returns The props.
 */
function props(remotePeers: readonly SceneRemotePeer[] = []): SceneViewportProps {
  return {
    objects: [FIGURE], selectedIds: [], mode: 'translate', readOnly: false,
    view: { position: [7, 5, 8], target: [0, 1, 0] }, focusRevision: 0, cancelRevision: 0,
    remotePeers, scaleSensitivity: 0.006, importLimits: IMPORT_LIMITS,
    jointMode: false, selectedJoint: null, onJointSelect: vi.fn(), onSkeletonState: vi.fn(),
    onSelect: vi.fn(), onGestureStart: vi.fn(() => true), onGestureChange: vi.fn(), onGestureEnd: vi.fn(), onViewChange: vi.fn(), onError: vi.fn(),
    resolveAsset: vi.fn(),
  };
}

/**
 * The last pose the viewport gave the figure, and whether it was settled.
 * @returns The object id, pose and settled flag of the last call.
 */
function lastPose(): { id: unknown; pose: unknown; settled: unknown } {
  const call = vi.mocked(applyPose).mock.lastCall;
  return { id: (call?.[0] as Object3D | undefined)?.userData.sceneObjectId, pose: call?.[1], settled: call?.[2] };
}

describe('the viewport poses the real figure and settles its bounds (inner#1692 acceptance 11 and 12)', () => {
  it('shows the document pose settled, a collaborator\'s drag unsettled, and the document pose settled again once it is withdrawn', async () => {
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    const onSkeletonState = vi.fn();
    const runtime = new SceneViewportRuntime(host, { ...props(), onSkeletonState }); owners.push(() => runtime.dispose());
    await vi.waitFor(() => expect(onSkeletonState).toHaveBeenCalledWith('one', 'humanoid'));
    expect(lastPose()).toEqual({ id: 'one', pose: LYING, settled: true });

    const dragging: SceneRemotePeer = { clientId: 7, userId: 'peer', color: '#ff0000', selectedIds: ['one'], gesture: [{ ...FIGURE, pose: WAVING }] };
    runtime.update(props([dragging]));
    expect(lastPose()).toEqual({ id: 'one', pose: WAVING, settled: false });

    runtime.update(props([{ ...dragging, gesture: null }]));
    expect(lastPose()).toEqual({ id: 'one', pose: LYING, settled: true });
  });

  it('repaints the joint dots in the new theme\'s colours when the theme changes', async () => {
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    host.style.setProperty('--color-status-selected', '#111111');
    host.style.setProperty('--color-foreground', '#222222');
    const onSkeletonState = vi.fn();
    const joints = { ...props(), selectedIds: ['one'], jointMode: true, selectedJoint: 'h:leftLowerArm', onSkeletonState };
    const runtime = new SceneViewportRuntime(host, joints); owners.push(() => runtime.dispose());
    await vi.waitFor(() => expect(onSkeletonState).toHaveBeenCalledWith('one', 'humanoid'));
    runtime.update(joints);
    const markers = (): Array<{ key: string; mesh: { material: { color: { getHexString(): string } } } }> =>
      (runtime as unknown as { markerItems: Array<{ key: string; mesh: { material: { color: { getHexString(): string } } } }> }).markerItems;
    await vi.waitFor(() => expect(markers().length).toBeGreaterThan(0));
    const colourOf = (key: string): string | undefined => markers().find((marker) => marker.key === key)?.mesh.material.color.getHexString();
    expect(colourOf('h:leftLowerArm')).toBe('222222');
    expect(colourOf('h:head')).toBe('111111');
    host.style.setProperty('--color-status-selected', '#333333');
    host.style.setProperty('--color-foreground', '#444444');
    document.documentElement.classList.toggle('dark');
    await vi.waitFor(() => expect(colourOf('h:leftLowerArm')).toBe('444444'));
    expect(colourOf('h:head')).toBe('333333');
    document.documentElement.classList.remove('dark');
  });

  it('sizes the joint dots to the character as it is scaled in joint mode, and keeps them as it is posed', async () => {
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    const onSkeletonState = vi.fn();
    const joints = { ...props(), selectedIds: ['one'], jointMode: true, selectedJoint: null, onSkeletonState };
    const runtime = new SceneViewportRuntime(host, joints); owners.push(() => runtime.dispose());
    await vi.waitFor(() => expect(onSkeletonState).toHaveBeenCalledWith('one', 'humanoid'));
    runtime.update(joints);
    const radius = (): number | undefined => (runtime as unknown as { markerItems: Array<{ mesh: { scale: { x: number } } }> }).markerItems[0]?.mesh.scale.x;
    await vi.waitFor(() => expect(radius()).toBeGreaterThan(0));
    const full = radius() ?? 0;
    runtime.update({ ...joints, objects: [{ ...FIGURE, scale: [0.2, 0.2, 0.2] }] });
    expect(radius()).toBeCloseTo(full * 0.2, 5);
    runtime.update({ ...joints, objects: [{ ...FIGURE, scale: [0.2, 0.2, 0.2], pose: WAVING }] });
    expect(radius()).toBeCloseTo(full * 0.2, 5);
  });
});
