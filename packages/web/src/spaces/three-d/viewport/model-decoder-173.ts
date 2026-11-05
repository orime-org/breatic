// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { LoadingManager, Texture } from 'three';
import type { Group, WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import dracoWrapper from 'three/addons/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasm from 'three/addons/libs/draco/gltf/draco_decoder.wasm?url';
import basisWrapper from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisWasm from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import type { SceneImportLimits } from '@breatic/shared';
import { z } from 'zod';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { resolveModelDependency } from '@web/spaces/three-d/model-package';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { isDrawable } from '@web/spaces/three-d/viewport/model-drawables';

export interface ModelDecoder {
  loader: GLTFLoader;
  /** Download the decoders the model declares, so a failed download surfaces before parsing as a plain, retryable error. */
  prepare: () => Promise<void>;
  dispose: () => void;
}

/**
 * Bind the fixed decoder assets and the model's closed resource collection.
 * @param model - Checked entry and original resources.
 * @param limits - Configured decoder concurrency.
 * @param renderer - Current device used to choose a KTX2 transcode format.
 * @param decoders - Which decoders the model needs, from loadedResources.
 * @param decoders.basisu - Whether a loaded texture decodes through KHR_texture_basisu.
 * @param decoders.draco - Whether a reached primitive is Draco compressed.
 * @returns A loader with explicitly owned workers and object URLs.
 * @throws {Error} When KTX2 textures need a renderer that was not given.
 */
export function createModelDecoder(model: ModelPackage, limits: SceneImportLimits, renderer: WebGLRenderer | undefined, decoders: { basisu: boolean; draco: boolean }): ModelDecoder {
  const { basisu, draco: dracoUsed } = decoders;
  if (basisu && !renderer) throw new Error('KTX2 decoding requires the current viewport capabilities');
  const decoderAssets = new Map([
    ['https://model-decoder.invalid/draco/draco_wasm_wrapper.js', dracoWrapper],
    ['https://model-decoder.invalid/draco/draco_decoder.wasm', dracoWasm],
    ['https://model-decoder.invalid/basis/basis_transcoder.js', basisWrapper],
    ['https://model-decoder.invalid/basis/basis_transcoder.wasm', basisWasm],
  ]);
  const urls = new Map<string, string>();
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    const decoder = decoderAssets.get(url);
    if (decoder) return decoder;
    // GLTFLoader creates blob URLs for images inside checked bufferViews.
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const path = resolveModelDependency(model.entry, url);
    let objectUrl = urls.get(path);
    if (!objectUrl) {
      const bytes = model.files.get(path);
      if (!bytes) throw new Error(`Missing model resource: ${path}`);
      objectUrl = URL.createObjectURL(new Blob([bytes]));
      urls.set(path, objectUrl);
    }
    return objectUrl;
  });
  const draco = new DRACOLoader(manager).setDecoderPath('https://model-decoder.invalid/draco/').setWorkerLimit(limits.decoderWorkerLimit);
  const ktx2 = renderer ? new KTX2Loader(manager).setTranscoderPath('https://model-decoder.invalid/basis/').setWorkerLimit(limits.decoderWorkerLimit).detectSupport(renderer) : null;
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  if (ktx2) loader.setKTX2Loader(ktx2);
  let disposed = false;
  return {
    loader,
    prepare: async () => {
      try {
        // r173 DRACOLoader exposes its decoder download promise only through _initDecoder, which caches it.
        /**
         * Start or join the cached Draco decoder download.
         * @returns The download, settled once the decoder is ready or has failed.
         * @throws {never} Never directly.
         */
        const dracoDownload = (): Promise<unknown> => (draco as DRACOLoader & { _initDecoder: () => Promise<unknown> })._initDecoder();
        if (dracoUsed) await dracoDownload();
        // GLTFLoader preloads a declared Draco decoder without handling a failed download; no loaded primitive needs it here.
        // A download finishing after dispose creates the worker source URL that dispose found absent.
        else if (model.json.extensionsUsed?.includes('KHR_draco_mesh_compression')) void dracoDownload().then(() => { if (disposed) draco.dispose(); }, () => undefined);
        if (ktx2 && basisu) await ktx2.init();
      } finally {
        // A dispose during the download found nothing to release; the finished download created the worker source URL.
        if (disposed) {
          draco.dispose();
          ktx2?.dispose();
        }
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      draco.dispose();
      ktx2?.dispose();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}

const imageSizeSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
const mipDataSchema = z.object({ data: z.custom<ArrayBufferView>((value) => ArrayBuffer.isView(value)) });

/**
 * Read the decoded mip bytes of a texture that carries its own mip levels, as a transcoded KTX2 texture does.
 * @param texture - A decoded texture.
 * @returns The bytes of every level, or undefined when the texture carries no mip data.
 * @throws {never} Never.
 */
export function measuredTextureBytes(texture: Texture): number | undefined {
  const levels = texture.mipmaps?.map((value) => mipDataSchema.safeParse(value)) ?? [];
  return levels.length && levels.every((value) => value.success)
    ? levels.reduce((sum, value) => sum + (value.success ? value.data.data.byteLength : 0), 0) : undefined;
}

/**
 * Check decoded textures before the first GPU upload of a model.
 * @param scenes - Parsed glTF scenes sharing the template's resources.
 * @param limits - Configured dimension budget, capped to this device's texture limit.
 * @throws {ModelImportError} When a decoded texture is not a 2D image or exceeds the dimension budget.
 */
export function validateModelTextures(scenes: readonly Group[], limits: SceneImportLimits): void {
  const textures = new Set<Texture>();
  for (const scene of scenes) scene.traverse((object) => {
    if (isDrawable(object)) for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  for (const texture of textures) {
    const image: unknown = texture.image;
    const parsed = imageSizeSchema.safeParse(image);
    if (!parsed.success) throw new ModelImportError('invalid', 'Model texture is not a 2D image', { detail: texture.name });
    const edge = Math.max(parsed.data.width, parsed.data.height);
    if (edge > limits.maxTextureEdge) {
      throw new ModelImportError('budget', 'Model texture exceeds the configured dimension budget', { detail: texture.name,
        budget: { limit: 'textureEdge', allowed: limits.maxTextureEdge, actual: edge } });
    }
  }
}
