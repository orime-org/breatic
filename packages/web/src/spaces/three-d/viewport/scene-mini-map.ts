// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Box3, Color, DoubleSide, type Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera, Plane, Raycaster, RingGeometry, Scene, Vector2, Vector3, WebGLRenderer } from 'three';
import type { SceneObject } from '@breatic/shared';
import type { ModelResourceCache, SceneModelLease } from '@web/spaces/three-d/viewport/model-resources';

/**
 * Fit complete world bounds in a top view with the host's actual aspect ratio.
 * @param camera - The overview's orthographic camera.
 * @param bounds - Current transformed model bounds including the personal target.
 * @param width - Visible overview width.
 * @param height - Visible overview height.
 * @throws {never} Never directly.
 */
export function fitSceneOverview(camera: OrthographicCamera, bounds: Box3, width: number, height: number): void {
  const aspect = width / height;
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const halfWidth = Math.max(5, size.x / 2, size.z / 2 * aspect) * 1.1;
  const margin = Math.max(1, size.y * 0.1);
  camera.left = -halfWidth; camera.right = halfWidth;
  camera.top = halfWidth / aspect; camera.bottom = -halfWidth / aspect;
  camera.position.set(center.x, bounds.max.y + margin, center.z);
  camera.up.set(0, 0, -1); camera.lookAt(center.x, bounds.min.y, center.z);
  camera.near = 0.01; camera.far = size.y + margin * 2;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
}

interface OverviewItem {
  source: string;
  lease: SceneModelLease;
  root: Group | null;
}

/**
 * Own an on-demand overview renderer and independent leases from the main view's cache.
 * @throws {Error} When WebGL construction fails.
 */
export class SceneMiniMapRuntime {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera();
  private readonly renderer: WebGLRenderer;
  private readonly marker = new Mesh(new RingGeometry(0.3, 0.4, 32), new MeshBasicMaterial({ side: DoubleSide }));
  private readonly items = new Map<string, OverviewItem>();
  private readonly resize: ResizeObserver;
  private readonly target = new Vector3();
  private objects: readonly SceneObject[] = [];
  private disposed = false;
  private renderKey = '';
  private width = 0;
  private height = 0;

  /**
   * Create native resources within the main viewport's effect lifetime.
   * @param host - The overview DOM allocation.
   * @param resources - The main viewport's immutable template cache.
   * @param navigate - Moves the personal camera to a world X/Z coordinate.
   * @param onError - Reports an active overview load failure through the scene owner.
   * @throws {Error} When WebGL is unavailable.
   */
  constructor(private readonly host: HTMLDivElement, private readonly resources: ModelResourceCache, private readonly navigate: (x: number, z: number) => void, private readonly onError?: (error: Error) => void) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.domElement.className = 'block h-full w-full';
    this.host.append(this.renderer.domElement);
    this.marker.rotation.x = -Math.PI / 2;
    this.scene.add(new HemisphereLight(0xffffff, 0x666666, 3), this.marker);
    this.renderer.domElement.addEventListener('click', this.onClick);
    this.resize = new ResizeObserver(() => this.render()); this.resize.observe(host);
  }

  /**
   * Reconcile only main-ready models and apply the latest complete transforms.
   * @param objects - The current scene projection, including gesture drafts.
   * @param ready - Model IDs admitted by the main viewport's completed loads.
   * @param target - This user's current orbit target.
   * @throws {never} Load failures release the overview lease.
   */
  update(objects: readonly SceneObject[], ready: ReadonlySet<string>, target: Vector3): void {
    if (this.disposed) return;
    this.objects = objects;
    this.target.copy(target);
    const existing = new Map(objects.filter((object) => object.exists).map((object) => [object.id, object]));
    for (const [id, item] of this.items) {
      const object = existing.get(id);
      if (!object || !ready.has(id) || JSON.stringify(object.model) !== item.source) this.remove(id);
    }
    for (const object of objects) {
      if (!object.exists || !ready.has(object.id)) continue;
      let item = this.items.get(object.id);
      if (!item) {
        const created: OverviewItem = { source: JSON.stringify(object.model), lease: this.resources.acquire(object.model), root: null };
        item = created; this.items.set(object.id, item);
        void created.lease.ready.then((root) => {
          if (this.disposed || this.items.get(object.id) !== created) { created.lease.release(); return; }
          created.root = root; root.userData.sceneObjectId = object.id; this.scene.add(root);
          this.render();
        }).catch((error: unknown) => {
          created.lease.release();
          if (!this.disposed && this.items.get(object.id) === created) {
            this.items.delete(object.id); this.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    }
    this.render();
  }

  /**
   * Withdraw the second lease before its main model is replaced or released.
   * @param id - Stable scene object identity.
   * @throws {never} Release is idempotent.
   */
  remove(id: string): void {
    this.items.get(id)?.lease.release(); this.items.delete(id);
  }

  /**
   * Render on content, target, theme or size changes using actual model bounds.
   * @throws {never} Never directly.
   */
  render(): void {
    if (this.disposed || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    const css = getComputedStyle(this.host);
    const background = css.getPropertyValue('--color-popover').trim();
    const foreground = css.getPropertyValue('--color-foreground').trim();
    const builtin = css.getPropertyValue('--color-muted-foreground').trim();
    const key = JSON.stringify([this.objects.filter((object) => this.items.get(object.id)?.root), this.target.toArray(), background, foreground, builtin, this.host.clientWidth, this.host.clientHeight]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    if (background) this.scene.background = new Color(background);
    if (foreground) this.marker.material.color.setStyle(foreground);
    const bounds = new Box3().expandByPoint(this.target);
    for (const object of this.objects) {
      const root = this.items.get(object.id)?.root;
      if (!root) continue;
      root.position.fromArray(object.position); root.quaternion.fromArray(object.rotation); root.scale.fromArray(object.scale); root.updateMatrixWorld(true);
      if (object.model.kind === 'builtin' && builtin) root.traverse((child) => {
        if (child instanceof Mesh) for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          if (material instanceof MeshStandardMaterial) material.color.setStyle(builtin);
        }
      });
      bounds.expandByObject(root);
    }
    fitSceneOverview(this.camera, bounds, this.host.clientWidth, this.host.clientHeight);
    this.marker.position.set(this.target.x, bounds.max.y + 0.01, this.target.z);
    if (this.width !== this.host.clientWidth || this.height !== this.host.clientHeight) {
      this.width = this.host.clientWidth; this.height = this.host.clientHeight;
      this.renderer.setSize(this.width, this.height, false);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Unproject through the same fitted camera used to draw the overview.
   * @param event - Pointer location in the overview canvas.
   * @throws {never} Never directly.
   */
  private onClick = (event: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.camera);
    const point = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -this.target.y), new Vector3());
    if (point) this.navigate(point.x, point.z);
  };

  /**
   * Release overview resources while the shared scene and main cache retain their owners.
   * @throws {never} Never directly.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.resize.disconnect();
    this.renderer.domElement.removeEventListener('click', this.onClick);
    for (const id of this.items.keys()) this.remove(id);
    this.marker.geometry.dispose(); this.marker.material.dispose(); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
