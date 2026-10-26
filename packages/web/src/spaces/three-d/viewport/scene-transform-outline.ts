// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { AlwaysStencilFunc, Color, Mesh, MeshBasicMaterial, NotEqualStencilFunc, ReplaceStencilOp, Scene, ShaderMaterial } from 'three';
import type { BufferGeometry, Camera, Material, Object3D, WebGLRenderer } from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { TransformControlsGizmo } from 'three/addons/controls/TransformControls.js';

const CONTOUR_LAYER = 2;

/**
 * Render the installed gizmo with contrasting neutral contours (inner#1705).
 * @throws {Error} When the helper differs from the installed r173 structure.
 */
export class SceneTransformOutline {
  private readonly scene = new Scene();
  private readonly effect: OutlineEffect;
  private readonly handles: Array<Mesh<BufferGeometry, MeshBasicMaterial>> = [];
  private readonly materials = new Set<Material>();
  private readonly mask = new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: AlwaysStencilFunc, stencilZPass: ReplaceStencilOp });
  private dark = new Color();
  private light = new Color();
  private pixel = 0;

  /**
   * Own the native helper and the outline materials generated for its meshes.
   * @param renderer - The viewport's existing renderer.
   * @param helper - The native r173 visual helper.
   * @throws {Error} When r173's gizmo is absent.
   */
  constructor(private readonly renderer: WebGLRenderer, private readonly helper: Object3D) {
    const gizmo = helper.children.find((child) => child instanceof TransformControlsGizmo);
    if (!(gizmo instanceof TransformControlsGizmo)) throw new Error('Unexpected TransformControls r173 helper');
    for (const group of Object.values(gizmo.gizmo)) group.traverse((child) => {
      if (!(child instanceof Mesh) || !(child.material instanceof MeshBasicMaterial)) return;
      child.material.depthTest = true;
      this.handles.push(child as Mesh<BufferGeometry, MeshBasicMaterial>);
    });
    this.scene.add(helper);
    this.materials.add(this.mask);
    this.scene.onBeforeRender = this.collectMaterials;
    this.effect = new OutlineEffect(renderer);
  }

  /**
   * Order the viewport's two existing neutral tokens by linear brightness.
   * @param foreground - The current foreground token.
   * @param background - The current canvas token.
   * @throws {never} Never directly.
   */
  setColors(foreground: string, background: string): void {
    const first = new Color(foreground);
    const second = new Color(background);
    const firstBrightness = first.r * 0.2126 + first.g * 0.7152 + first.b * 0.0722;
    const secondBrightness = second.r * 0.2126 + second.g * 0.7152 + second.b * 0.0722;
    [this.dark, this.light] = firstBrightness < secondBrightness ? [first, second] : [second, first];
  }

  /**
   * Calibrate native NDC extrusion against the current CSS viewport size.
   * @param width - Positive viewport width in CSS pixels.
   * @param height - Positive viewport height in CSS pixels.
   * @throws {never} Never.
   */
  setSize(width: number, height: number): void { this.pixel = 2 / Math.min(width, height); }

  /**
   * Track the effect's generated shaders, whose r173 cache has no disposal API.
   * @throws {never} Never.
   */
  private collectMaterials = (): void => {
    this.scene.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (material instanceof ShaderMaterial && material.type === 'OutlineEffect') {
          material.depthWrite = false;
          material.stencilWrite = true;
          material.stencilWriteMask = 0;
          material.stencilRef = 1;
          material.stencilFunc = NotEqualStencilFunc;
          this.materials.add(material);
        }
      }
    });
  };

  /**
   * Draw one contour through the native material's documented effect parameters.
   * @param camera - The personal view camera.
   * @param color - A resolved neutral token in linear colour space.
   * @param pixels - The nominal contour width at the viewport's shorter dimension.
   * @throws {Error} When the renderer fails to draw.
   */
  private contour(camera: Camera, color: Color, pixels: number): void {
    const parameters = { color: color.toArray(), thickness: this.pixel * pixels, alpha: 1 };
    for (const handle of this.handles) {
      handle.material.userData.outlineParameters = parameters;
    }
    this.effect.renderOutline(this.scene, camera);
  }

  /**
   * Draw both contours and the native core after the world scene has rendered.
   * @param camera - The personal view camera, restored to its original layers afterward.
   * @throws {Error} When the renderer fails to draw.
   */
  render(camera: Camera): void {
    this.scene.updateMatrixWorld(true);
    if (!this.helper.visible) return;
    for (const handle of this.handles) {
      if (handle.layers.isEnabled(0)) handle.layers.enable(CONTOUR_LAYER);
      else handle.layers.disable(CONTOUR_LAYER);
    }
    const autoClear = this.renderer.autoClear;
    const layers = camera.layers.mask;
    this.renderer.autoClear = false;
    try {
      this.renderer.clearDepth();
      this.renderer.clearStencil();
      camera.layers.set(CONTOUR_LAYER);
      this.scene.overrideMaterial = this.mask;
      this.renderer.render(this.scene, camera);
      this.scene.overrideMaterial = null;
      this.contour(camera, this.dark, 2.5);
      this.contour(camera, this.light, 1.5);
      camera.layers.mask = layers;
      this.renderer.render(this.scene, camera);
    } finally {
      this.scene.overrideMaterial = null;
      camera.layers.mask = layers;
      this.renderer.autoClear = autoClear;
    }
  }

  /**
   * Release the mask and generated shaders at the visible viewport's lifetime boundary.
   * @throws {never} Never directly.
   */
  dispose(): void {
    for (const material of this.materials) material.dispose();
    this.materials.clear();
    this.scene.clear();
  }
}
