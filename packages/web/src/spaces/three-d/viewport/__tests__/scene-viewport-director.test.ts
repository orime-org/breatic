// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, HemisphereLight, PerspectiveCamera, Quaternion, Vector3, type Object3D, type Scene, type WebGLRenderTarget } from 'three';
import type { SceneObject } from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { SceneViewportRuntime } from '@web/spaces/three-d/viewport/scene-viewport-runtime';
import type { SceneFrameCapture, SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

interface CameraState { fov: number; aspect: number; position: number[]; quaternion: number[]; up: number[]; view: { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number } | null }
interface LightState { type: string; id: string | null; visible: boolean; intensity: number; castShadow: boolean; color: string }
interface RenderCall { target: WebGLRenderTarget | null; camera: CameraState; lights: LightState[]; shown: Record<string, boolean> }

const renders: RenderCall[] = [];
const programs: Array<{ getUniforms: () => { seq: Array<{ id: string; type: number; size?: number }> } }> = [];
const shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };

/** Plain camera values at the moment of a render. */
function cameraState(camera: PerspectiveCamera): CameraState {
  const view = camera.view?.enabled ? camera.view : null;
  return { fov: camera.fov, aspect: camera.aspect, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), up: camera.up.toArray(),
    view: view && { fullWidth: view.fullWidth, fullHeight: view.fullHeight, offsetX: view.offsetX, offsetY: view.offsetY, width: view.width, height: view.height } };
}

/** Whether any drawable part of a record's display reaches this camera. */
function shownTo(root: Object3D, camera: PerspectiveCamera): boolean {
  let shown = false;
  root.traverseVisible((child) => {
    if ((child as { isMesh?: boolean; isLine?: boolean; isSprite?: boolean }).isMesh || (child as { isLine?: boolean }).isLine || (child as { isSprite?: boolean }).isSprite) {
      if (camera.layers.test(child.layers)) shown = true;
    }
  });
  return shown;
}

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    shadowMap = shadowMap;
    capabilities = { maxTextures: 16 };
    private target: WebGLRenderTarget | null = null;
    setPixelRatio(): void {} setSize(): void {} dispose(): void {} compile(): void {} getPixelRatio(): number { return 1; }
    setViewport(): void {} setScissor(): void {} setScissorTest(): void {}
    setRenderTarget(target: WebGLRenderTarget | null): void { this.target = target; }
    getRenderTarget(): WebGLRenderTarget | null { return this.target; }
    render(scene: Scene, camera: PerspectiveCamera): void {
      const lights: LightState[] = [];
      const shown: Record<string, boolean> = {};
      scene.traverse((child) => {
        if (child instanceof actual.Light) {
          let owner: Object3D | null = child;
          while (owner && typeof owner.userData.sceneObjectId !== 'string') owner = owner.parent;
          lights.push({ type: child.type, id: owner ? owner.userData.sceneObjectId as string : null, visible: child.visible && (owner?.visible ?? true), intensity: child.intensity, castShadow: child.castShadow, color: child.color.getHexString() });
        }
        if (typeof child.userData.sceneObjectId === 'string') shown[child.userData.sceneObjectId as string] = shownTo(child, camera);
      });
      renders.push({ target: this.target, camera: cameraState(camera), lights, shown });
    }
    async readRenderTargetPixelsAsync(_target: WebGLRenderTarget, _x: number, _y: number, _w: number, _h: number, buffer: Uint8Array): Promise<Uint8Array> { return buffer; }
    info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs };
    getContext(): unknown { return { isContextLost: () => false, getParameter: () => 'test', RENDERER: 0, VERSION: 0 }; }
  } };
});
vi.mock('@web/spaces/three-d/viewport/model-resources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/three-d/viewport/model-resources')>();
  const { Group: G, Mesh, BoxGeometry, MeshStandardMaterial } = await import('three');
  return { ...actual, loadSceneModel: vi.fn(async () => { const g = new G(); g.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial())); return g; }) };
});

const CAM = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const LAMP = '00000000-0000-4000-8000-000000001001';
const ROLLED = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
const camera = (id: string, extra: Record<string, unknown> = {}): SceneObject => ({ id, name: 'Camera', model: { kind: 'camera' }, position: [0, 1.5, 6], rotation: ROLLED.toArray() as [number, number, number, number], scale: [1, 1, 1], locked: false, number: 1, focalLength: 50, frame: '16:9', ...extra } as unknown as SceneObject);
const lamp = (extra: Record<string, unknown> = {}): SceneObject => ({ id: LAMP, name: 'Point light 1', model: { kind: 'light', type: 'point' }, position: [1, 3, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, number: 1, color: '#ff8800', intensity: 5, castShadow: true, ...extra } as unknown as SceneObject);
const CUBE: SceneObject = { id: 'cube', model: { kind: 'builtin', id: 'box' }, name: 'Cube', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const FRAME = { x: 180, y: 120, width: 640, height: 360 };
const VIEW = { position: [7, 5, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number] };
const DIRECTOR = { maxLights: 16, wheelCommitMs: 400, shadowMapPx: 2048, pointShadowMapPx: 512, shadowGroundReach: 3 };
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); renders.length = 0; programs.length = 0; shadowMap.needsUpdate = false; });

/** Props for a scene holding a cube and the given director records. */
function props(objects: readonly SceneObject[], extra: Partial<SceneViewportProps> & Record<string, unknown> = {}): SceneViewportProps {
  return {
    objects: [CUBE, ...objects], selectedIds: [], mode: 'translate', readOnly: false,
    view: VIEW, focusRevision: 0, cancelRevision: 0, remotePeers: [],
    scaleSensitivity: 0.006, importLimits: IMPORT_LIMITS,
    jointMode: false, selectedJoint: null, onJointSelect: vi.fn(), onSkeletonState: vi.fn(),
    onSelect: vi.fn(), onGestureStart: vi.fn(() => true), onGestureChange: vi.fn(), onGestureEnd: vi.fn(), onViewChange: vi.fn(), onError: vi.fn(),
    onModelStateChange: vi.fn(), resolveAsset: vi.fn(),
    director: DIRECTOR, environment: { ambientColor: '#ffffff', ambientIntensity: 2.7 },
    onPilotPreview: vi.fn(), onPilotEnd: vi.fn(), onPilotLocked: vi.fn(),
    ...extra,
  } as SceneViewportProps;
}

interface Opened {
  runtime: SceneViewportRuntime;
  initial: SceneViewportProps;
  main: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  orbit: { enabled: boolean };
  frame: () => RenderCall;
  capture: () => SceneFrameCapture;
  size: { width: number; height: number };
}

/** Open a runtime on a 1000×600 host and wait for the cube. */
async function open(initial: SceneViewportProps): Promise<Opened> {
  const host = document.createElement('div'); document.body.append(host);
  const size = { width: 1000, height: 600 };
  Object.defineProperties(host, { clientWidth: { get: () => size.width }, clientHeight: { get: () => size.height } });
  let capture: SceneFrameCapture | null = null;
  const runtime = new SceneViewportRuntime(host, { ...initial, onCapture: (value) => { capture = value; } });
  owners.push(() => runtime.dispose());
  await vi.waitFor(() => expect(initial.onModelStateChange).toHaveBeenCalledWith('cube', 'ready'));
  const inner = runtime as unknown as { camera: PerspectiveCamera; orbit: { enabled: boolean }; renderer: { domElement: HTMLCanvasElement }; onFrame: () => void; onResize: () => void };
  const canvas = inner.renderer.domElement;
  canvas.getBoundingClientRect = (): DOMRect => ({ left: 0, top: 0, width: size.width, height: size.height, right: size.width, bottom: size.height, x: 0, y: 0, toJSON: () => ({}) });
  canvas.setPointerCapture = (): void => {};
  canvas.releasePointerCapture = (): void => {};
  return {
    runtime, initial, main: inner.camera, canvas, orbit: inner.orbit, size,
    frame: () => { renders.length = 0; inner.onFrame(); const call = renders.find((entry) => entry.target === null); if (!call) throw new Error('no screen render'); return call; },
    capture: () => { if (!capture) throw new Error('no capture'); return capture; },
  };
}

/** The projection a camera record should have for a frame ratio. */
function expectedFov(focalLength: number, aspect: number): number {
  const reference = new PerspectiveCamera(45, aspect);
  reference.filmGauge = 36;
  reference.setFocalLength(focalLength);
  return reference.fov;
}

const pointer = (type: string, x: number, y: number, extra: Record<string, unknown> = {}): Event =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }), { pointerId: 1, pointerType: 'mouse', ...extra });

describe('looking through a camera (inner#1694 design 3.4, 3.4.3)', () => {
  it('shows the camera position, roll, lens and frame ratio, with the frame cut by a view offset', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    const call = opened.frame();
    expect(call.camera.position).toEqual([0, 1.5, 6]);
    call.camera.quaternion.forEach((value, index) => expect(value).toBeCloseTo(ROLLED.toArray()[index] ?? NaN, 9));
    expect(call.camera.fov).toBeCloseTo(expectedFov(50, 16 / 9), 9);
    expect(call.camera.aspect).toBeCloseTo(16 / 9, 9);
    expect(call.camera.view).toEqual({ fullWidth: 640, fullHeight: 360, offsetX: -180, offsetY: -120, width: 1000, height: 600 });
  });

  it('hides the looked-through camera and keeps other cameras shown', async () => {
    const opened = await open(props([camera(CAM), camera(OTHER, { position: [3, 1, 3], number: 2 })], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    const call = opened.frame();
    expect(call.shown[CAM]).toBe(false);
    expect(call.shown[OTHER]).toBe(true);
  });

  it('ignores the personal view, focus requests and resizes as a source of the main camera pose', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    opened.runtime.update({ ...opened.initial, cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME, view: { position: [20, 20, 20], target: [0, 0, 0] }, focusRevision: 1 } as SceneViewportProps);
    opened.size.width = 1200;
    (opened.runtime as unknown as { onResize: () => void }).onResize();
    const call = opened.frame();
    expect(call.camera.position).toEqual([0, 1.5, 6]);
    expect(call.camera.aspect).toBeCloseTo(16 / 9, 9);
    expect(call.camera.view?.width).toBe(1200);
  });

  it('keeps orbiting off while a camera view lasts, even after an object handle drag ends', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    expect(opened.orbit.enabled).toBe(false);
    const controls = (opened.runtime as unknown as { controls: { dispatchEvent: (event: { type: string; value: boolean }) => void } }).controls;
    controls.dispatchEvent({ type: 'dragging-changed', value: false });
    expect(opened.orbit.enabled).toBe(false);
  });

  it('restores the free view, upright and at 45 degrees, after leaving the camera', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    opened.frame();
    opened.runtime.update({ ...opened.initial, cameraView: null, viewFrame: null } as SceneViewportProps);
    const call = opened.frame();
    expect(call.camera.up).toEqual([0, 1, 0]);
    expect(call.camera.fov).toBe(45);
    expect(call.camera.aspect).toBeCloseTo(1000 / 600, 9);
    expect(call.camera.view).toBeNull();
    call.camera.position.forEach((value, index) => expect(value).toBeCloseTo(VIEW.position[index] ?? NaN, 9));
    expect(opened.orbit.enabled).toBe(true);
  });

  it('holds a frozen view still when the camera record or the window changes', async () => {
    const frozen = { kind: 'frozen' as const, id: CAM, position: [0, 1.5, 6] as [number, number, number], quaternion: ROLLED.toArray() as [number, number, number, number], fov: 30, aspect: 9 / 16 };
    const opened = await open(props([camera(CAM)], { cameraView: frozen, viewFrame: { x: 400, y: 20, width: 180, height: 320 } }));
    opened.runtime.update({ ...opened.initial, objects: [CUBE, camera(CAM, { position: [5, 5, 5], focalLength: 85 })], cameraView: frozen, viewFrame: { x: 400, y: 20, width: 180, height: 320 } } as SceneViewportProps);
    const call = opened.frame();
    expect(call.camera.position).toEqual([0, 1.5, 6]);
    expect(call.camera.fov).toBe(30);
    expect(call.camera.aspect).toBeCloseTo(9 / 16, 9);
  });

  it('keeps the camera a still was taken through hidden while the still is shown', async () => {
    const frozen = { kind: 'frozen' as const, id: CAM, position: [0, 1.5, 6] as [number, number, number], quaternion: ROLLED.toArray() as [number, number, number, number], fov: 30, aspect: 16 / 9 };
    const opened = await open(props([camera(CAM), camera(OTHER, { position: [3, 1, 3], number: 2 })], { cameraView: frozen, viewFrame: FRAME }));
    const call = opened.frame();
    expect(call.shown[CAM]).toBe(false);
    expect(call.shown[OTHER]).toBe(true);
  });

  it('draws no part of a camera icon in front of the camera, so a view standing on a camera is never covered by it', async () => {
    const opened = await open(props([camera(CAM)]));
    opened.frame();
    const scene = (opened.runtime as unknown as { scene: Scene }).scene;
    let root: Object3D | undefined;
    scene.traverse((child) => { if (child.userData.sceneObjectId === CAM) root = child; });
    if (!root) throw new Error('no camera figure');
    const inverse = root.matrixWorld.clone().invert();
    const nearest: number[] = [];
    root.traverse((child) => {
      if (!(child as { isMesh?: boolean; isSprite?: boolean }).isMesh && !(child as { isSprite?: boolean }).isSprite) return;
      const box = new Box3().setFromObject(child).applyMatrix4(inverse);
      nearest.push(box.min.z);
    });
    expect(nearest.length).toBeGreaterThan(0);
    expect(Math.min(...nearest)).toBeGreaterThanOrEqual(-1e-9);
  });

  it('starts a rebuilt runtime in the camera view it is given', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: false }, viewFrame: FRAME }));
    expect(opened.frame().camera.position).toEqual([0, 1.5, 6]);
  });

  it('still cancels the browser menu and page scroll on the canvas once orbiting is off for a camera view', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: false }, viewFrame: FRAME }));
    expect(opened.orbit.enabled).toBe(false);
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    opened.canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    opened.canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it('captures through the camera projection without touching the main view offset', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    opened.frame();
    renders.length = 0;
    await opened.capture()(FRAME, { width: 2048, height: 1152 });
    const shot = renders.find((call) => call.target !== null);
    expect(shot?.camera.view).toBeNull();
    expect(shot?.camera.position).toEqual([0, 1.5, 6]);
    expect(shot?.camera.fov).toBeCloseTo(expectedFov(50, 16 / 9), 9);
    expect(shot?.shown[CAM]).toBe(false);
    expect(opened.main.view?.enabled).toBe(true);
    expect(opened.main.view?.offsetX).toBe(-180);
  });
});

describe('piloting a camera (design 3.4.1, 6.2)', () => {
  it('turns the camera with a drag past 4 px, keeps its roll and ends once on release', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    opened.canvas.dispatchEvent(pointer('pointerdown', 500, 300));
    opened.canvas.dispatchEvent(pointer('pointermove', 502, 300));
    expect(opened.initial.onPilotPreview).not.toHaveBeenCalled();
    opened.canvas.dispatchEvent(pointer('pointermove', 560, 330));
    opened.canvas.dispatchEvent(pointer('pointerup', 560, 330));
    const preview = vi.mocked(opened.initial.onPilotPreview as (...args: unknown[]) => void).mock.lastCall as [string, number[], number[]];
    expect(preview[0]).toBe(CAM);
    expect(preview[1]).not.toEqual([0, 1.5, 6]);
    const right = (q: number[]): number => new Vector3(1, 0, 0).applyQuaternion(new Quaternion().fromArray(q)).y;
    expect(right(preview[2])).toBeCloseTo(right(ROLLED.toArray()), 9);
    expect(opened.initial.onPilotEnd).toHaveBeenCalledTimes(1);
    expect(opened.initial.onPilotEnd).toHaveBeenCalledWith(true);
    expect(opened.initial.onSelect).not.toHaveBeenCalled();
  });

  it('pilots when the drag starts on a model', async () => {
    const opened = await open(props([camera(CAM, { position: [0, 0.5, 4], rotation: [0, 0, 0, 1] })], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    opened.canvas.dispatchEvent(pointer('pointerdown', 500, 300));
    opened.canvas.dispatchEvent(pointer('pointermove', 540, 300));
    opened.canvas.dispatchEvent(pointer('pointerup', 540, 300));
    expect(opened.initial.onPilotEnd).toHaveBeenCalledWith(true);
    expect(opened.initial.onGestureStart).not.toHaveBeenCalled();
  });

  it('writes nothing for a click and says nothing for a click on a locked camera', async () => {
    const opened = await open(props([camera(CAM, { locked: true })], { cameraView: { kind: 'live', id: CAM, canPilot: false }, viewFrame: FRAME }));
    opened.canvas.dispatchEvent(pointer('pointerdown', 500, 300));
    opened.canvas.dispatchEvent(pointer('pointerup', 500, 300));
    expect(opened.initial.onPilotEnd).not.toHaveBeenCalled();
    expect(opened.initial.onPilotLocked).not.toHaveBeenCalled();
    opened.canvas.dispatchEvent(pointer('pointerdown', 500, 300));
    opened.canvas.dispatchEvent(pointer('pointermove', 560, 300));
    opened.canvas.dispatchEvent(pointer('pointermove', 600, 300));
    opened.canvas.dispatchEvent(pointer('pointerup', 600, 300));
    expect(opened.initial.onPilotLocked).toHaveBeenCalledTimes(1);
    expect(opened.initial.onPilotPreview).not.toHaveBeenCalled();
    expect(opened.frame().camera.position).toEqual([0, 1.5, 6]);
  });

  it('drops a drag in progress when the camera gets locked, back to the record', async () => {
    const opened = await open(props([camera(CAM)], { cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    opened.canvas.dispatchEvent(pointer('pointerdown', 500, 300));
    opened.canvas.dispatchEvent(pointer('pointermove', 560, 300));
    opened.runtime.update({ ...opened.initial, objects: [CUBE, camera(CAM, { locked: true })], cameraView: { kind: 'live', id: CAM, canPilot: false }, viewFrame: FRAME } as SceneViewportProps);
    opened.canvas.dispatchEvent(pointer('pointermove', 620, 300));
    opened.canvas.dispatchEvent(pointer('pointerup', 620, 300));
    expect(opened.initial.onPilotEnd).toHaveBeenCalledTimes(1);
    expect(opened.initial.onPilotEnd).toHaveBeenCalledWith(false);
    expect(opened.frame().camera.position).toEqual([0, 1.5, 6]);
  });
});

describe('lights, ambient and shadows (design 3.6, 6.4)', () => {
  const userLights = (call: RenderCall): LightState[] => call.lights.filter((light) => light.id !== null);
  const defaultKey = (call: RenderCall): LightState | undefined => call.lights.find((light) => light.id === null && light.type === 'DirectionalLight');

  it('keeps the default key light, without shadow, while there is no user light', async () => {
    const opened = await open(props([]));
    const key = defaultKey(opened.frame());
    expect(key).toMatchObject({ visible: true, intensity: 3, castShadow: false });
  });

  it('turns the default key light off once a user light exists and lights with the record colour and intensity', async () => {
    const opened = await open(props([lamp()]));
    const call = opened.frame();
    expect(defaultKey(call)?.visible ?? false).toBe(false);
    expect(userLights(call)).toEqual([expect.objectContaining({ type: 'PointLight', id: LAMP, visible: true, intensity: 5, color: 'ff8800' })]);
  });

  it('paints the ambient light from the scene setting', async () => {
    const opened = await open(props([], { environment: { ambientColor: '#ffeecc', ambientIntensity: 1.5 } }));
    opened.frame();
    const hemisphere: HemisphereLight[] = [];
    (opened.runtime as unknown as { scene: Scene }).scene.traverse((child) => { if (child instanceof HemisphereLight) hemisphere.push(child); });
    expect(hemisphere).toHaveLength(1);
    expect(hemisphere[0]?.color.getHexString()).toBe('ffeecc');
    expect(hemisphere[0]?.intensity).toBe(1.5);
  });

  it('casts no shadow until a mesh program has been compiled, then within the budget', async () => {
    const opened = await open(props([lamp()]));
    expect(userLights(opened.frame())[0]?.castShadow).toBe(false);
    programs.push({ getUniforms: () => ({ seq: [{ id: 'map', type: 0x8b5e }, { id: 'boneTexture', type: 0x8b5e }, { id: 'pointShadowMap', type: 0x8b5e, size: 4 }, { id: 'diffuse', type: 0x8b51 }] }) });
    opened.runtime.update({ ...opened.initial, objects: [CUBE, lamp({ intensity: 6 })] } as SceneViewportProps);
    expect(userLights(opened.frame())[0]?.castShadow).toBe(true);
  });

  it('turns shadow-map updates off and redraws them only when a display value changes', async () => {
    const opened = await open(props([lamp()]));
    expect(shadowMap.enabled).toBe(true);
    expect(shadowMap.autoUpdate).toBe(false);
    opened.frame();
    shadowMap.needsUpdate = false;
    opened.frame();
    expect(shadowMap.needsUpdate).toBe(false);
    opened.runtime.update({ ...opened.initial, objects: [CUBE, lamp({ position: [2, 3, 1] })] } as SceneViewportProps);
    expect(shadowMap.needsUpdate).toBe(true);
  });

  it('reports no model state for cameras and lights', async () => {
    const opened = await open(props([camera(CAM), lamp()]));
    const ids = vi.mocked(opened.initial.onModelStateChange as (...args: unknown[]) => void).mock.calls.map((call) => call[0]);
    expect(ids).not.toContain(CAM);
    expect(ids).not.toContain(LAMP);
  });
});

describe('handles during a camera view (design 3.4 item 1)', () => {
  it('attaches no transform handle while the selection holds the camera being looked through', async () => {
    const opened = await open(props([camera(CAM), camera(OTHER, { position: [3, 1, 3], number: 2 })], { selectedIds: [CAM, 'cube'], cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME }));
    const controls = (opened.runtime as unknown as { controls: { object: unknown } }).controls;
    expect(controls.object ?? null).toBeNull();
    opened.runtime.update({ ...opened.initial, selectedIds: [OTHER], cameraView: { kind: 'live', id: CAM, canPilot: true }, viewFrame: FRAME } as SceneViewportProps);
    expect(controls.object ?? null).not.toBeNull();
  });
});
