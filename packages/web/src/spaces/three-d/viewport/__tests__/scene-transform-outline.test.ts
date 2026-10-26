// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, Object3D, PerspectiveCamera, Scene, ShaderMaterial } from 'three';
import type { Camera, Color, Material, MeshBasicMaterial, WebGLRenderer } from 'three';
import { TransformControlsGizmo } from 'three/addons/controls/TransformControls.js';
import { SceneTransformControls173 } from '@web/spaces/three-d/viewport/transform-controls-173';
import { SceneTransformOutline } from '@web/spaces/three-d/viewport/scene-transform-outline';

interface Pass { mask: Material | null; materials: ShaderMaterial[]; colors: string[]; alpha: number[]; thickness: number[]; layer: number; }
const owners: Array<() => void> = [];
afterEach(() => { owners.splice(0).forEach((dispose) => dispose()); });

function fixture(): {
  controls: SceneTransformControls173; outline: SceneTransformOutline; camera: PerspectiveCamera; renderer: WebGLRenderer;
  passes: Pass[]; render: ReturnType<typeof vi.fn>; gizmo: TransformControlsGizmo;
  } {
  const passes: Pass[] = [];
  const camera = new PerspectiveCamera(45, 1.5, 0.05, 5000); camera.position.set(5, 4, 7); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const controls = new SceneTransformControls173(camera, document.createElement('canvas'), 0.006, vi.fn());
  const target = new Object3D(); new Scene().add(target); controls.attach(target);
  const render = vi.fn((scene: Scene, view: Camera) => {
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld(true);
    scene.onBeforeRender(renderer, scene, view, undefined as never, undefined as never, undefined as never);
    const pass: Pass = { mask: scene.overrideMaterial, materials: [], colors: [], alpha: [], thickness: [], layer: view.layers.mask };
    scene.traverseVisible((child) => {
      if (!(child instanceof Mesh) || !view.layers.test(child.layers)) return;
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        child.onBeforeRender(renderer, scene, view, child.geometry, material, undefined as never);
        if (!(material instanceof ShaderMaterial) || material.type !== 'OutlineEffect') continue;
        pass.materials.push(material);
        pass.colors.push((material.uniforms.outlineColor.value as Color).getHexString());
        pass.alpha.push(material.uniforms.outlineAlpha.value as number);
        pass.thickness.push(material.uniforms.outlineThickness.value as number);
      }
    });
    passes.push(pass);
  });
  const renderer = { autoClear: true, shadowMap: { enabled: true }, domElement: document.createElement('canvas'), render, clearDepth: vi.fn(), clearStencil: vi.fn() } as unknown as WebGLRenderer;
  const outline = new SceneTransformOutline(renderer, controls.getHelper());
  outline.setColors('#f0f0f0', '#2c2c2c'); outline.setSize(1200, 800);
  owners.push(() => { outline.dispose(); controls.dispose(); });
  const gizmo = controls.getHelper().children.find((child) => child instanceof TransformControlsGizmo);
  if (!(gizmo instanceof TransformControlsGizmo)) throw new Error('Expected installed gizmo');
  return { controls, outline, camera, renderer, passes, render, gizmo };
}

describe('native transform contrast contours (inner#1705)', () => {
  it.each(['translate', 'rotate', 'scale'] as const)('draws two opaque neutral contours and then native %s handles', (mode) => {
    const { controls, outline, camera, passes, renderer } = fixture(); controls.setMode(mode);
    outline.render(camera);
    expect(passes).toHaveLength(4);
    expect(passes[0].mask).toMatchObject({ colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1 });
    expect(new Set(passes[1].colors)).toEqual(new Set(['2c2c2c']));
    expect(new Set(passes[2].colors)).toEqual(new Set(['f0f0f0']));
    expect(passes[1].alpha.every((alpha) => alpha === 1)).toBe(true);
    expect(passes[2].alpha.every((alpha) => alpha === 1)).toBe(true);
    expect(passes[3].materials).toEqual([]);
    expect(renderer.autoClear).toBe(true); expect(renderer.shadowMap.enabled).toBe(true); expect(camera.layers.mask).toBe(1);
  });

  it('preserves native picker masks, helper visibility and original material identity across a frame', () => {
    const { controls, outline, camera, gizmo } = fixture(); controls.setMultipleSelection(true); controls.setMode('scale');
    const pickers = gizmo.picker.scale.children.map((child) => ({ child, mask: child.layers.mask }));
    const handles = gizmo.gizmo.scale.children.filter((child): child is Mesh => child instanceof Mesh);
    const materials = handles.map((child) => child.material);
    outline.render(camera);
    expect(pickers.map(({ child }) => child.layers.mask)).toEqual(pickers.map(({ mask }) => mask));
    expect(handles.map((child) => child.material)).toEqual(materials);
    expect(handles.filter((child) => child.layers.isEnabled(0)).map((child) => child.name)).toEqual(['XYZ']);
    controls.setMultipleSelection(false); outline.render(camera);
    expect(handles.every((child) => child.layers.isEnabled(0))).toBe(true);
  });

  it('retains native hover colors and translucent plane fills', () => {
    const { controls, outline, camera, gizmo } = fixture(); controls.axis = 'Z';
    outline.render(camera);
    const z = gizmo.gizmo.translate.children.find((child) => child.name === 'Z') as Mesh;
    expect((z.material as MeshBasicMaterial).color.getHexString()).toBe('ffff00');
    const xy = gizmo.gizmo.translate.children.find((child) => child.name === 'XY') as Mesh;
    expect((xy.material as MeshBasicMaterial).opacity).toBe(0.5);
  });

  it('updates both contours for a theme change and calibrates thickness on resize', () => {
    const { outline, camera, passes } = fixture(); outline.render(camera);
    const initial = passes[1].thickness[0];
    outline.setColors('#1e1e1e', '#e3e3e3'); outline.setSize(600, 400); outline.render(camera);
    expect(new Set(passes[5].colors)).toEqual(new Set(['1e1e1e']));
    expect(new Set(passes[6].colors)).toEqual(new Set(['e3e3e3']));
    expect(passes[5].thickness[0]).toBe(initial * 2);
    expect(passes[5].thickness[0]).toBeGreaterThan(passes[6].thickness[0]);
  });

  it('reuses generated materials and releases every generated contour material on disposal', () => {
    const { outline, camera, passes } = fixture(); outline.render(camera); outline.render(camera);
    const generated = [...new Set(passes.flatMap((pass) => pass.materials))];
    expect(passes[1].materials[0]).toBeInstanceOf(ShaderMaterial);
    expect(passes[1].materials).toEqual(passes[2].materials);
    expect(passes[1].materials).toEqual(passes[5].materials);
    const dispose = generated.map((material) => vi.spyOn(material, 'dispose'));
    const maskDispose = vi.spyOn(passes[0].mask as Material, 'dispose');
    outline.dispose(); outline.dispose();
    expect(dispose.map((spy) => spy.mock.calls.length)).toEqual(generated.map(() => 1));
    expect(generated.every((material) => material.depthWrite === false)).toBe(true);
    expect(generated.every((material) => material.stencilWrite && material.stencilWriteMask === 0 && material.stencilRef === 1)).toBe(true);
    expect(maskDispose).toHaveBeenCalledTimes(1);
  });

  it('skips rendering when the native controls detach', () => {
    const { controls, outline, camera, passes } = fixture(); controls.detach(); outline.render(camera);
    expect(passes).toEqual([]);
  });
});
