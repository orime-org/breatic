// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Bone, BoxGeometry, Group, Mesh, Vector3, type MeshBasicMaterial, type Object3D, type PerspectiveCamera, type SphereGeometry } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SceneObject } from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { applyPose } from '@web/spaces/three-d/viewport/pose-rig';
import { POSE_PRESETS } from '@web/spaces/three-d/viewport/pose-presets';
import { loadSceneModel } from '@web/spaces/three-d/viewport/model-resources';
import { SceneViewportRuntime } from '@web/spaces/three-d/viewport/scene-viewport-runtime';
import type { SceneRemotePeer, SceneSkeletonState, SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

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
 * A sized host for a viewport, with the given CSS variables set before the viewport reads them.
 * @param style - CSS variables to set.
 * @returns The host.
 */
function hostOf(style: Readonly<Record<string, string>> = {}): HTMLDivElement {
  const host = document.createElement('div'); document.body.append(host);
  Object.defineProperties(host, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  for (const [name, value] of Object.entries(style)) host.style.setProperty(name, value);
  return host;
}

type JointDot = { key: string; mesh: Mesh<SphereGeometry, MeshBasicMaterial> };

/**
 * Open joint mode on the one object and wait for its dots.
 * @param overrides - Props to change.
 * @param kind - The skeleton the model reports.
 * @param style - CSS variables set on the host before the dots are made.
 * @returns The runtime, its props and its dots.
 */
async function openJoints(overrides: Partial<SceneViewportProps> = {}, kind: SceneSkeletonState = 'humanoid', style: Readonly<Record<string, string>> = {}): Promise<{ runtime: SceneViewportRuntime; joints: SceneViewportProps; host: HTMLDivElement; dots: () => JointDot[] }> {
  const host = hostOf(style);
  const onSkeletonState = vi.fn();
  const joints = { ...props(), selectedIds: ['one'], jointMode: true, selectedJoint: null, onSkeletonState, ...overrides };
  const runtime = new SceneViewportRuntime(host, joints); owners.push(() => runtime.dispose());
  await vi.waitFor(() => expect(onSkeletonState).toHaveBeenCalledWith('one', kind));
  runtime.update(joints);
  const dots = (): JointDot[] => (runtime as unknown as { markerItems: JointDot[] }).markerItems;
  await vi.waitFor(() => expect(dots().length).toBeGreaterThan(0));
  return { runtime, joints, host, dots };
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
    const onSkeletonState = vi.fn();
    const runtime = new SceneViewportRuntime(hostOf(), { ...props(), onSkeletonState }); owners.push(() => runtime.dispose());
    await vi.waitFor(() => expect(onSkeletonState).toHaveBeenCalledWith('one', 'humanoid'));
    expect(lastPose()).toEqual({ id: 'one', pose: LYING, settled: true });

    const dragging: SceneRemotePeer = { clientId: 7, userId: 'peer', color: '#ff0000', selectedIds: ['one'], gesture: [{ ...FIGURE, pose: WAVING }] };
    runtime.update(props([dragging]));
    expect(lastPose()).toEqual({ id: 'one', pose: WAVING, settled: false });

    runtime.update(props([{ ...dragging, gesture: null }]));
    expect(lastPose()).toEqual({ id: 'one', pose: LYING, settled: true });
  });

  it('repaints the joint dots in the new theme\'s colours when the theme changes', async () => {
    const { host, dots } = await openJoints({ selectedJoint: 'h:leftLowerArm' }, 'humanoid', { '--color-status-selected': '#111111', '--color-foreground': '#222222' });
    const colourOf = (key: string): string | undefined => dots().find((dot) => dot.key === key)?.mesh.material.color.getHexString();
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
    const { runtime, joints, dots } = await openJoints();
    const radius = (): number | undefined => dots()[0]?.mesh.scale.x;
    const full = radius() ?? 0;
    runtime.update({ ...joints, objects: [{ ...FIGURE, scale: [0.2, 0.2, 0.2] }] });
    expect(radius()).toBeCloseTo(full * 0.2, 5);
    runtime.update({ ...joints, objects: [{ ...FIGURE, scale: [0.2, 0.2, 0.2], pose: WAVING }] });
    expect(radius()).toBeCloseTo(full * 0.2, 5);
  });

  it('keeps every joint dot clear of its neighbours, the body dots at full size', async () => {
    const { dots } = await openJoints();
    const radiusOf = (key: string): number => dots().find((dot) => dot.key === key)?.mesh.scale.x ?? 0;
    expect(dots().length).toBeGreaterThan(40);
    for (const [index, a] of dots().entries()) {
      for (const b of dots().slice(index + 1)) {
        expect(a.mesh.position.distanceTo(b.mesh.position), `${a.key} and ${b.key}`).toBeGreaterThan(a.mesh.scale.x + b.mesh.scale.x);
      }
    }
    expect(radiusOf('h:leftThumbMetacarpal')).toBeLessThan(radiusOf('h:hips') / 2);
    expect(radiusOf('h:hips')).toBeCloseTo(radiusOf('h:head'), 6);
  });

  it('sizes the joint dots from the character at rest, whatever pose it holds when joint mode opens', async () => {
    /**
     * The hips dot's radius when joint mode opens on the figure in a pose.
     * @param pose - The figure's document pose.
     * @returns The radius.
     */
    const hipsDot = async (pose: SceneObject['pose']): Promise<number> => {
      const { dots } = await openJoints({ objects: [{ ...FIGURE, pose }] });
      return dots().find((dot) => dot.key === 'h:hips')?.mesh.scale.x ?? 0;
    };
    expect(await hipsDot(POSE_PRESETS.sit)).toBeCloseTo(await hipsDot({}), 6);
  });

  it('shows a dot for each of two joints that sit at the same point', async () => {
    const model = new Group();
    model.add(new Mesh(new BoxGeometry(0.5, 1.75, 0.3)));
    const root = new Bone(); root.name = 'Root';
    const left = new Bone(); left.name = 'PelvisL'; left.position.set(0, 1, 0);
    const right = new Bone(); right.name = 'PelvisR'; right.position.set(0, 1, 0);
    root.add(left, right); model.add(root);
    vi.mocked(loadSceneModel).mockResolvedValueOnce(model);
    const { dots } = await openJoints({}, 'other');
    expect(dots()).toHaveLength(3);
    for (const dot of dots()) expect(dot.mesh.scale.x, dot.key).toBeGreaterThan(0.005);
  });

  it('selects the dot whose centre a click lands on, even through the larger selected dot in front of it', async () => {
    const onJointSelect = vi.fn();
    const { runtime, joints, dots } = await openJoints({ selectedJoint: 'h:leftThumbMetacarpal', onJointSelect });
    const inner = runtime as unknown as { camera: PerspectiveCamera; renderer: { domElement: HTMLCanvasElement } };
    const at = (key: string): Vector3 => dots().find((dot) => dot.key === key)?.mesh.position.clone() ?? new Vector3();
    const selected = at('h:leftThumbMetacarpal');
    const target = at('h:leftThumbProximal');
    // Look past the selected joint at the next one, slightly off their line, so the selected dot is in front.
    const along = selected.clone().sub(target);
    const across = new Vector3(0, 1, 0).cross(along).normalize().multiplyScalar(along.length() * 0.5);
    const eye = target.clone().add(along.clone().add(across).normalize().multiplyScalar(0.4));
    runtime.update({ ...joints, view: { position: eye.toArray(), target: target.toArray() } });
    inner.camera.updateMatrixWorld(true);
    const ndc = target.clone().project(inner.camera);
    const canvas = inner.renderer.domElement;
    canvas.getBoundingClientRect = (): DOMRect => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    const point = { clientX: (ndc.x + 1) / 2 * 400, clientY: (1 - ndc.y) / 2 * 300, button: 0 };
    const pointer = (type: string): Event => Object.assign(new MouseEvent(type, { ...point, bubbles: true }), { pointerId: 1 });
    canvas.dispatchEvent(pointer('pointerdown'));
    canvas.dispatchEvent(pointer('pointerup'));
    expect(onJointSelect).toHaveBeenLastCalledWith('h:leftThumbProximal');
  });
});
