// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Box3, Group, InstancedMesh, SkinnedMesh, Texture, Vector3 } from 'three';
import type { BufferGeometry, Material, Skeleton, WebGLRenderer } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { httpRequest, isSceneModelMediaType } from '@breatic/shared';
import type { SceneImportLimits, SceneObject } from '@breatic/shared';
import { createBuiltinModel } from '@web/spaces/three-d/viewport/builtin-models';
import type { ResolvedSceneAsset } from '@web/spaces/three-d/viewport/scene-viewport-props';
import type { ModelBounds } from '@web/spaces/three-d/model-import-controller';
import { inspectModelFiles } from '@web/spaces/three-d/model-package';
import { readRegisteredModelPackageInWorker } from '@web/spaces/three-d/model-import-worker-client';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { createModelDecoder, validateModelTextures } from '@web/spaces/three-d/viewport/model-decoder-173';
import { imageLocation, validateModelTextureBytes, validateModelTextureMetadata } from '@web/spaces/three-d/model-texture-metadata';
import { loadedResources } from '@web/spaces/three-d/model-loaded-resources';
import { contentFailure, ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { detectTextureFormatSupport } from '@web/spaces/three-d/model-texture-format';
import { isDrawable } from '@web/spaces/three-d/viewport/model-drawables';

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
 * Release an instance's mutable materials, independent skeletons and per-copy instance buffers only.
 * @param root - The independent model instance being detached; its shared geometry and textures remain cached.
 * @throws {never} Never directly.
 */
function disposeInstance(root: Group): void {
  const materials = new Set<Material>();
  const skeletons = new Set<Skeleton>();
  const instanced = new Set<InstancedMesh>();
  root.traverse((child) => {
    if (isDrawable(child)) for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
    if (child instanceof SkinnedMesh) skeletons.add(child.skeleton);
    if (child instanceof InstancedMesh) instanced.add(child);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  // Each copy owns its instance matrix and colours; dispose releases those buffers, not the shared geometry.
  for (const mesh of instanced) mesh.dispose();
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
  const instanced = new Set<InstancedMesh>();
  for (const scene of ownedScenes.get(root) ?? [root]) scene.traverse((child) => {
    if (!isDrawable(child)) return;
    if (child instanceof InstancedMesh) instanced.add(child);
    geometries.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
    if (child instanceof SkinnedMesh) skeletons.add(child.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  for (const mesh of instanced) mesh.dispose();
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
    if (!isDrawable(child)) return;
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

/** A placement's hold on one model, answering where its geometry sits. */
export interface MeasuredSceneModelLease {
  bounds: Promise<ModelBounds>;
  release: () => void;
}

/**
 * Hold a model for placing it: measure the shared template's bounds so the object
 * can be put on the ground, and keep the template until the viewport holds it too.
 * @param cache - The viewport's own cache, so the viewport reuses what this loads.
 * @param source - The model to place.
 * @returns The bounds and this holder's release.
 * @throws {Error} The bounds reject when the model cannot load.
 */
export function acquireMeasured(cache: ModelResourceCache, source: SceneModelSource): MeasuredSceneModelLease {
  const lease = cache.acquire(source);
  return {
    bounds: lease.ready.then((instance) => {
      const box = new Box3().setFromObject(instance);
      return { center: box.getCenter(new Vector3()).toArray(), min: box.min.toArray() };
    }),
    release: lease.release,
  };
}

/**
 * Read a registered complete model through the shared HTTP transport.
 * @param source - The immutable source from the scene document.
 * @param signal - Invalidated when the last holder leaves.
 * @param resolveAsset - Permission-aware application resolver for registered assets.
 * @param builtinColor - The current semantic object colour.
 * @param limits - Import budgets injected from the Project configuration.
 * @param renderer - Current device capabilities used for texture decoding.
 * @returns A template whose immutable resources belong to the cache.
 * @throws {Error} When resolving, transferring or parsing the model fails.
 */
export async function loadSceneModel(
  source: SceneModelSource,
  signal: AbortSignal,
  resolveAsset: (assetId: string, signal: AbortSignal) => Promise<ResolvedSceneAsset>,
  builtinColor: string,
  limits: SceneImportLimits,
  renderer?: WebGLRenderer,
): Promise<Group> {
  if (source.kind === 'builtin') return createBuiltinModel(source.id, builtinColor);
  const asset = await resolveAsset(source.assetId, signal);
  if (!isSceneModelMediaType(asset.mimeType)) throw new ModelImportError('unsupported', 'Scene asset has an unsupported model type', { detail: asset.mimeType });
  if (signal.aborted) throw new DOMException('Scene model load cancelled', 'AbortError');
  if (asset.sizeBytes > limits.maxArtifactBytes) {
    throw new ModelImportError('budget', 'Registered model exceeds its configured asset budget', { detail: '',
      budget: { limit: 'artifact', allowed: limits.maxArtifactBytes, actual: asset.sizeBytes } });
  }
  const response = await httpRequest(asset.url, { method: 'GET' }, { replaySafe: true, signal });
  if (!response.ok) throw new Error(`Scene model request failed (${response.status})`);
  const bytes = await readModelBytes(response, limits.maxArtifactBytes, signal);
  const model = asset.mimeType === 'application/zip'
    ? await readRegisteredModelPackageInWorker(bytes, signal, limits)
    : inspectModelFiles(new Map([['model.glb', bytes]]), 'model.glb', limits, await detectTextureFormatSupport());
  return parseSceneModel(model, signal, limits, renderer);
}

/**
 * Stop reading actual response bytes when the configured asset budget is reached.
 * @param response - The registered asset response.
 * @param maxBytes - Configured maximum artifact size.
 * @param signal - Current model lease's cancellation signal.
 * @returns An owned bounded buffer.
 * @throws {Error} When transfer, cancellation or the byte budget fails.
 */
async function readModelBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error('Registered model response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        throw new ModelImportError('budget', 'Registered model exceeds its configured asset budget', { detail: '',
          budget: { limit: 'artifact', allowed: maxBytes, actual: size } });
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * Parse the same closed model collection for import preview and registered use.
 * @param model - Checked entry and original resources.
 * @param signal - The owning operation or lease's signal.
 * @param limits - Configured metadata, decoder and texture budgets.
 * @param renderer - Current renderer supplying KTX2 device capabilities.
 * @returns A template whose scenes belong to disposeModelTemplate.
 * @throws {ModelImportError} When the model content, its textures or its budgets are refused.
 * @throws {Error} When a decoder download fails, which a retry can resolve.
 * @throws {DOMException} When the load is cancelled.
 */
export async function parseSceneModel(model: ModelPackage, signal: AbortSignal, limits: SceneImportLimits, renderer?: WebGLRenderer): Promise<Group> {
  signal.throwIfAborted();
  const textureLimits = { ...limits, maxTextureEdge: Math.min(limits.maxTextureEdge, renderer?.capabilities.maxTextureSize ?? limits.maxTextureEdge) };
  const sizes = validateModelTextureMetadata(model, limits, textureLimits.maxTextureEdge);
  const { textures, basisu, draco } = loadedResources(model.json, model.support);
  const decoder = createModelDecoder(model, limits, renderer, { basisu, draco });
  const bytes = model.files.get(model.entry)!;
  // GLTFLoader only reads the buffer, so a view spanning its whole buffer is passed without a copy.
  const input = model.entry.toLowerCase().endsWith('.gltf') ? new TextDecoder().decode(bytes)
    : bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  // A decoder download failure is not about the model, so it bypasses the content handler below and stays retryable.
  const parsed = decoder.prepare().then(() => signal.throwIfAborted()).then(() => decoder.loader.parseAsync(input, '').then(async (result) => {
    // GLTFLoader resolves without a scene when the model has none or its default scene index is out of range.
    const root = result.scene ?? new Group();
    ownedScenes.set(root, result.scenes);
    try {
      if (!result.scene) throw new ModelImportError('empty', 'Model has no scene to display', { detail: model.entry });
      signal.throwIfAborted();
      // GLTFLoader turns a texture that fails to decode or transcode into null and still resolves the model.
      const decoded = await Promise.all(textures.map(({ texture }) => result.parser.getDependency('texture', texture) as Promise<Texture | null>));
      signal.throwIfAborted();
      const failed = textures.find((_, position) => decoded[position] === null);
      // inspectModelFiles refused every used texture that names no image.
      if (failed) throw new ModelImportError('invalid', 'Model texture could not be decoded', { detail: imageLocation(model, failed.image!) });
      validateModelTextures(result.scenes, textureLimits);
      validateModelTextureBytes(model.json, sizes, limits);
      return result.scene;
    } catch (error) {
      disposeModelTemplate(root);
      throw signal.aborted ? error : contentFailure(error);
    }
  }, (error: unknown) => { throw contentFailure(error); }));
  let abort: (() => void) | undefined;
  try {
    return await new Promise<Group>((resolve, reject) => {
      abort = () => {
        decoder.dispose();
        reject(new DOMException('Scene model load cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void parsed.then(resolve, reject);
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    decoder.dispose();
  }
}
