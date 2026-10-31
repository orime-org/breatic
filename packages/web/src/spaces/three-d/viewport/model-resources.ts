// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { BufferGeometry, Group, LoadingManager, Material, Mesh, SkinnedMesh, Texture } from 'three';
import type { Skeleton } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { httpRequest } from '@breatic/shared';
import type { SceneObject } from '@breatic/shared';
import { createBuiltinModel } from '@web/spaces/three-d/viewport/builtin-models';
import type { ResolvedSceneAsset } from '@web/spaces/three-d/viewport/scene-viewport-props';

/** Additional parsed scenes stay owned until the active template is released. */
const ownedScenes = new WeakMap<Group, readonly Group[]>();

export type SceneModelSource = SceneObject['model'];
export type SceneModelLoader = (source: SceneModelSource, signal: AbortSignal) => Promise<Group>;
export interface SceneModelLease {
  ready: Promise<Group>;
  release: () => void;
}
interface ResourceEntry {
  refs: number;
  abort: AbortController;
  root: Group | null;
  ready: Promise<Group>;
}

/**
 * Release an instance's mutable materials and independent skeleton only.
 * @param root - The independent model instance being detached; its shared geometry and textures remain cached.
 * @throws {never} Never directly.
 */
function disposeInstance(root: Group): void {
  const materials = new Set<Material>();
  const skeletons = new Set<Skeleton>();
  root.traverse((child) => {
    if (child instanceof Mesh) for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
    if (child instanceof SkinnedMesh) skeletons.add(child.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  root.removeFromParent();
}

/**
 * Release the last holder's immutable geometry and textures exactly once.
 * @param root - The cached model template that owns the parsed scenes and their shared GPU resources.
 * @throws {never} Never directly.
 */
export function disposeModelTemplate(root: Group): void {
  const geometries = new Set<BufferGeometry>();
  const textures = new Set<Texture>();
  const materials = new Set<Material>();
  const skeletons = new Set<Skeleton>();
  for (const scene of ownedScenes.get(root) ?? [root]) scene.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    geometries.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
    if (child instanceof SkinnedMesh) skeletons.add(child.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  ownedScenes.delete(root);
  for (const geometry of geometries) geometry.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    const image: unknown = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) images.add(image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
  root.removeFromParent();
}

/**
 * Clone skeletons and materials while retaining immutable template resources.
 * @param root - The cached source hierarchy whose geometry and textures remain shared by its instances.
 * @returns A cloned hierarchy with independent skeletons and editable materials.
 * @throws {never} Never directly.
 */
function instantiate(root: Group): Group {
  // SkeletonUtils preserves the source constructor; its declaration erases it.
  const instance = clone(root) as Group;
  const materials = new Map<Material, Material>();
  instance.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    /**
     * Clone a material once within this independent instance.
     * @param source - The template material to clone, or retrieve from this instance's material map.
     * @returns This instance's material clone, reused wherever the source material recurs.
     * @throws {never} Never directly.
     */
    const ownMaterial = (source: Material): Material => {
      let own = materials.get(source);
      if (!own) {
        own = source.clone();
        materials.set(source, own);
      }
      return own;
    };
    child.material = Array.isArray(child.material) ? child.material.map(ownMaterial) : ownMaterial(child.material);
  });
  return instance;
}

/**
 * Cache immutable templates for the current viewport's living instances.
 * @throws {Error} When the supplied loader rejects a model.
 */
export class ModelResourceCache {
  private readonly entries = new Map<string, ResourceEntry>();
  private readonly holders = new Set<() => void>();
  private readonly load: SceneModelLoader;

  /**
   * Accept an asset transport so ownership tests use actual Three resources.
   * @param load - Loads an owned model template for a source and abort signal; the cache manages its eventual release.
   * @throws {never} Never.
   */
  constructor(load: SceneModelLoader) {
    this.load = load;
  }

  /**
   * Hold one independent instance, also while its shared template is loading.
   * @param source - The immutable builtin identifier or registered asset ID used to share one cached template.
   * @returns A lease whose ready promise yields an independent instance and whose release callback relinquishes this holder once.
   * @throws {Error} The ready promise rejects when loading or parsing fails.
   */
  acquire(source: SceneModelSource): SceneModelLease {
    const key = source.kind === 'builtin' ? `builtin:${source.id}` : `asset:${source.assetId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const abort = new AbortController();
      const created: ResourceEntry = {
        refs: 0, abort, root: null,
        ready: this.load(source, abort.signal).then((root) => {
          if (created.refs === 0) disposeModelTemplate(root);
          else created.root = root;
          return root;
        }),
      };
      entry = created;
      this.entries.set(key, entry);
    }
    const held = entry;
    held.refs += 1;
    let released = false;
    let instance: Group | null = null;
    /**
     * Release only this holder; late results remain owned by their entry.
     * @throws {never} Never directly.
     */
    const release = (): void => {
      if (released) return;
      released = true;
      this.holders.delete(release);
      if (instance) disposeInstance(instance);
      held.refs -= 1;
      if (held.refs === 0) {
        held.abort.abort();
        if (held.root) disposeModelTemplate(held.root);
        held.root = null;
        if (this.entries.get(key) === held) this.entries.delete(key);
      }
    };
    this.holders.add(release);
    return {
      ready: held.ready.then((root) => {
        if (released) throw new DOMException('Scene model holder released', 'AbortError');
        instance = instantiate(root);
        return instance;
      }),
      release,
    };
  }

  /**
   * Release every outstanding holder when Activity tears down its view.
   * @throws {never} Never directly.
   */
  dispose(): void {
    for (const release of [...this.holders]) release();
  }
}

/**
 * Read a registered GLB through the shared HTTP transport, then parse locally.
 * External dependency bundles are part of model import rather than placement.
 * @param source - The immutable source from the scene document.
 * @param signal - Invalidated when the last holder leaves.
 * @param resolveAsset - Permission-aware application resolver for registered assets.
 * @param builtinColor - The current semantic object colour.
 * @returns A template whose immutable resources belong to the cache.
 * @throws {Error} When resolving, transferring or parsing the model fails.
 */
export async function loadSceneModel(
  source: SceneModelSource,
  signal: AbortSignal,
  resolveAsset: (assetId: string, signal: AbortSignal) => Promise<ResolvedSceneAsset>,
  builtinColor: string,
): Promise<Group> {
  if (source.kind === 'builtin') return createBuiltinModel(source.id, builtinColor);
  const asset = await resolveAsset(source.assetId, signal);
  if (asset.mimeType !== 'model/gltf-binary') throw new Error('Scene asset has an unsupported model type');
  if (signal.aborted) throw new DOMException('Scene model load cancelled', 'AbortError');
  const response = await httpRequest(asset.url, { method: 'GET' }, { replaySafe: true, signal });
  if (!response.ok) throw new Error(`Scene model request failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 4 || new DataView(bytes).getUint32(0, true) !== 0x46546c67) throw new Error('Scene asset is not a binary glTF model');
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    throw new Error('Scene model requires external dependencies');
  });
  const result = await new GLTFLoader(manager).parseAsync(bytes, '');
  ownedScenes.set(result.scene, result.scenes);
  return result.scene;
}
