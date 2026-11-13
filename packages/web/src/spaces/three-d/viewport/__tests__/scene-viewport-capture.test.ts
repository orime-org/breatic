// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SRGBColorSpace, type GridHelper, type Group, type Object3D, type PerspectiveCamera, type WebGLRenderTarget } from 'three';
import type { SceneObject } from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { SceneViewportRuntime } from '@web/spaces/three-d/viewport/scene-viewport-runtime';
import type { SceneFrameCapture, SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

interface RenderCall {
  target: WebGLRenderTarget | null;
  helpers: boolean[];
  view: { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number } | null;
  background: string | null;
}
const renders: RenderCall[] = [];
const reads: Array<{ target: WebGLRenderTarget; width: number; height: number }> = [];
let observeHelpers: () => boolean[] = () => [];

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    private target: WebGLRenderTarget | null = null;
    setPixelRatio(): void {} setSize(): void {} dispose(): void {}
    setRenderTarget(target: WebGLRenderTarget | null): void { this.target = target; }
    getRenderTarget(): WebGLRenderTarget | null { return this.target; }
    render(scene: { background: unknown }, camera: PerspectiveCamera): void {
      const view = camera.view?.enabled ? { ...camera.view } : null;
      renders.push({ target: this.target, helpers: observeHelpers(), view: view && { fullWidth: view.fullWidth, fullHeight: view.fullHeight, offsetX: view.offsetX, offsetY: view.offsetY, width: view.width, height: view.height },
        background: scene.background instanceof actual.Color ? scene.background.getHexString() : null });
    }
    async readRenderTargetPixelsAsync(target: WebGLRenderTarget, _x: number, _y: number, width: number, height: number, buffer: Uint8Array): Promise<Uint8Array> {
      reads.push({ target, width, height });
      buffer.fill(7);
      return buffer;
    }
    info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] };
    getContext(): unknown { return { isContextLost: () => false, getParameter: () => 'test', RENDERER: 0, VERSION: 0 }; }
  } };
});
vi.mock('@web/spaces/three-d/viewport/model-resources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/three-d/viewport/model-resources')>();
  const { Group: G, Mesh, BoxGeometry, MeshStandardMaterial } = await import('three');
  return { ...actual, loadSceneModel: vi.fn(async () => { const g = new G(); g.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial())); return g; }) };
});

const CUBE: SceneObject = { id: 'cube', model: { kind: 'builtin', id: 'box' }, name: 'Cube', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); renders.length = 0; reads.length = 0; });

/**
 * Viewport props with one selected cube.
 * @param onCapture - Where the runtime hands its capture function.
 * @returns The props.
 */
function props(onCapture: (capture: SceneFrameCapture | null) => void): SceneViewportProps {
  return {
    objects: [CUBE], selectedIds: ['cube'], mode: 'translate', readOnly: false,
    view: { position: [7, 5, 8], target: [0, 1, 0] }, focusRevision: 0, cancelRevision: 0,
    remotePeers: [{ clientId: 2, userId: 'peer', color: '#ff0000', selectedIds: ['cube'], gesture: null }],
    scaleSensitivity: 0.006, importLimits: IMPORT_LIMITS,
    jointMode: false, selectedJoint: null, onJointSelect: vi.fn(), onSkeletonState: vi.fn(),
    onSelect: vi.fn(), onGestureStart: vi.fn(() => true), onGestureChange: vi.fn(), onGestureEnd: vi.fn(), onViewChange: vi.fn(), onError: vi.fn(),
    onModelStateChange: vi.fn(), resolveAsset: vi.fn(), onCapture,
  };
}

/**
 * Open a runtime on a 1000×600 host and wait until its cube is drawn.
 * @returns The runtime, its capture function and its hidden helpers.
 */
async function open(): Promise<{ runtime: SceneViewportRuntime; capture: SceneFrameCapture; camera: PerspectiveCamera }> {
  const host = document.createElement('div'); document.body.append(host);
  Object.defineProperties(host, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
  host.style.setProperty('--color-background', '#123456');
  let capture: SceneFrameCapture | null = null;
  const initial = props((value) => { capture = value; });
  const runtime = new SceneViewportRuntime(host, initial); owners.push(() => runtime.dispose());
  await vi.waitFor(() => expect(initial.onModelStateChange).toHaveBeenCalledWith('cube', 'ready'));
  runtime.update(initial);
  const inner = runtime as unknown as { grid: GridHelper; controls: { getHelper: () => Object3D }; outlines: Object3D[]; markers: Group; camera: PerspectiveCamera };
  observeHelpers = () => [inner.grid.visible, inner.controls.getHelper().visible, inner.markers.visible, ...inner.outlines.map((outline) => outline.visible)];
  expect(inner.outlines.length).toBe(2);
  if (!capture) throw new Error('the runtime did not hand over its capture');
  return { runtime, capture, camera: inner.camera };
}

describe('capturing the viewfinder frame (#1411 design 4)', () => {
  it('renders the frame once into a 4-sample sRGB target at the output size, with every helper hidden', async () => {
    const { capture } = await open();
    renders.length = 0;
    const shot = await capture({ x: 100, y: 50, width: 400, height: 225 }, { width: 2048, height: 1152 });

    const offscreen = renders.filter((call) => call.target !== null);
    expect(offscreen).toHaveLength(1);
    const target = offscreen[0]?.target;
    expect(target?.width).toBe(2048);
    expect(target?.height).toBe(1152);
    expect(target?.samples).toBe(4);
    expect(target?.texture.colorSpace).toBe(SRGBColorSpace);
    expect(offscreen[0]?.helpers.every((visible) => !visible)).toBe(true);
    expect(offscreen[0]?.view).toEqual({ fullWidth: 5120, fullHeight: 3072, offsetX: 512, offsetY: 256, width: 2048, height: 1152 });
    expect(offscreen[0]?.background).toBe('123456');
    expect(reads).toEqual([{ target, width: 2048, height: 1152 }]);
    expect(shot.width).toBe(2048);
    expect(shot.height).toBe(1152);
    expect(shot.pixels).toHaveLength(2048 * 1152 * 4);
  });

  it('restores the helpers, the camera view and the screen target afterwards, and releases the target', async () => {
    const { runtime, capture, camera } = await open();
    renders.length = 0;
    let disposed = 0;
    const dispose = vi.spyOn((await import('three')).WebGLRenderTarget.prototype, 'dispose').mockImplementation(() => { disposed += 1; });
    await capture({ x: 0, y: 0, width: 300, height: 300 }, { width: 2048, height: 2048 });
    dispose.mockRestore();

    expect(observeHelpers().every(Boolean)).toBe(true);
    expect(camera.view?.enabled ?? false).toBe(false);
    expect(disposed).toBe(1);
    expect((runtime as unknown as { renderer: { getRenderTarget: () => unknown } }).renderer.getRenderTarget()).toBeNull();
  });

  it('withdraws the capture function before the runtime is disposed', async () => {
    const host = document.createElement('div'); document.body.append(host);
    Object.defineProperties(host, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
    const onCapture = vi.fn();
    const runtime = new SceneViewportRuntime(host, props(onCapture));
    expect(onCapture).toHaveBeenLastCalledWith(expect.any(Function));
    runtime.dispose();
    expect(onCapture).toHaveBeenLastCalledWith(null);
  });

  it('stops orbiting while the view is locked after a capture', async () => {
    const { runtime } = await open();
    const orbit = (runtime as unknown as { orbit: { enabled: boolean } }).orbit;
    runtime.update({ ...props(() => undefined), viewLocked: true });
    expect(orbit.enabled).toBe(false);
    runtime.update({ ...props(() => undefined), viewLocked: false });
    expect(orbit.enabled).toBe(true);
  });
});
