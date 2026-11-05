// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { imageDimensionsFromData } from 'image-dimensions';
import type { SceneImportLimits } from '@breatic/shared';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { loadedImageUri, readModelResource, resolveModelDependency } from '@web/spaces/three-d/model-package';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { loadedResources, loadedResourcesInEveryBrowser } from '@web/spaces/three-d/model-loaded-resources';
import type { GltfDocument } from '@web/spaces/three-d/model-package';

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** Everything one image check reads: the model, its decoded data URIs and the image's location for failures. */
interface ImageRead {
  model: ModelPackage;
  /** Data URIs decoded during this validation; images that share an embedded buffer decode it once. */
  decoded: Map<string, Uint8Array<ArrayBuffer>>;
  location: string;
}

/**
 * Resolve an image view within both the actual and declared buffer bounds.
 * @param read - The model, the decoded data URIs and the image location.
 * @param index - Image's declared bufferView index.
 * @returns The original image byte view.
 * @throws {ModelImportError} When an index, offset or declared range is invalid.
 */
function readImageView(read: ImageRead, index: number): Uint8Array<ArrayBuffer> {
  const { model, location } = read;
  const view = Number.isSafeInteger(index) && index >= 0 ? model.json.bufferViews?.[index] : undefined;
  if (!view || !Number.isSafeInteger(view.buffer) || view.buffer < 0) throw new ModelImportError('invalid', 'Invalid model image buffer view', { detail: location });
  const buffer = model.json.buffers?.[view.buffer];
  if (!buffer || buffer.byteLength === undefined || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0) {
    throw new ModelImportError('invalid', 'Invalid model image buffer', { detail: location });
  }
  const offset = view.byteOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength <= 0
    || offset > buffer.byteLength || view.byteLength > buffer.byteLength - offset) {
    throw new ModelImportError('invalid', 'Model image view exceeds its declared buffer', { detail: location });
  }
  // inspectModelFiles established that every loaded buffer is readable and as long as declared.
  return readModelResource(model, buffer.uri, location, read.decoded).subarray(offset, offset + view.byteLength);
}

/** An image's declared pixel dimensions. */
export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Read one image's declared dimensions and hold them to the edge budget.
 * @param read - The model, the decoded data URIs and the image location.
 * @param image - The glTF image declaration.
 * @param limits - The texture dimension budget for this image.
 * @returns The image's declared dimensions.
 * @throws {ModelImportError} When the image is invalid or exceeds its dimension budget.
 */
function checkImage(read: ImageRead, image: NonNullable<ModelPackage['json']['images']>[number], limits: SceneImportLimits): ImageSize {
  const { location } = read;
  const uri = loadedImageUri(image);
  const bytes = uri !== undefined ? readModelResource(read.model, uri, read.location, read.decoded)
    : image.bufferView !== undefined ? readImageView(read, image.bufferView) : undefined;
  if (!bytes) throw new ModelImportError('invalid', 'Model image has no source', { detail: location });
  let dimensions: { width: number; height: number } | undefined;
  if (KTX2_IDENTIFIER.every((value, index) => bytes[index] === value)) {
    if (bytes.byteLength < 80) throw new ModelImportError('invalid', 'Truncated KTX2 image header', { detail: location });
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dimensions = { width: header.getUint32(20, true), height: header.getUint32(24, true) };
  } else dimensions = imageDimensionsFromData(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw new ModelImportError('invalid', 'Invalid model image metadata', { detail: location });
  const edge = Math.max(dimensions.width, dimensions.height);
  if (edge > limits.maxTextureEdge) {
    throw new ModelImportError('budget', 'Model texture exceeds its configured dimension budget', { detail: location,
      budget: { limit: 'textureEdge', allowed: limits.maxTextureEdge, actual: edge } });
  }
  return dimensions;
}

/**
 * Check the dimensions of the images GLTFLoader decodes in any browser that can open the model, before the browser decodes their pixels.
 * Every such image is held to the configured edge; the images this browser decodes are also held to this device's texture limit.
 * A failure names the image by its file path, or by its index when the image is embedded.
 * @param model - Checked original glTF resources.
 * @param limits - Configured texture dimension budget, shared by every collaborator.
 * @param deviceMaxEdge - The largest texture edge this device uploads; the configured edge when there is no device limit.
 * @returns The declared dimensions of every checked image, by image index.
 * @throws {ModelImportError} When an image is invalid or exceeds its dimension budget.
 */
export function validateModelTextureMetadata(model: ModelPackage, limits: SceneImportLimits, deviceMaxEdge = limits.maxTextureEdge): Map<number, ImageSize> {
  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  const local = loadedResources(model.json, model.support).images;
  const deviceLimits = { ...limits, maxTextureEdge: Math.min(limits.maxTextureEdge, deviceMaxEdge) };
  // loadedResources lists only images that exist.
  const sizes = new Map<number, ImageSize>();
  for (const index of new Set(loadedResourcesInEveryBrowser(model.json).flatMap((resources) => [...resources.images]))) {
    sizes.set(index, checkImage({ model, decoded, location: imageLocation(model, index) }, model.json.images![index], local.has(index) ? deviceLimits : limits));
  }
  return sizes;
}

/** GLTFLoader's WEBGL_FILTERS and WEBGL_WRAPPINGS keys; any other value takes the loader's default. */
const MAG_FILTERS: ReadonlySet<unknown> = new Set([9728, 9729]);
const MIN_FILTERS: ReadonlySet<unknown> = new Set([9728, 9729, 9984, 9985, 9986, 9987]);
const WRAPPINGS: ReadonlySet<unknown> = new Set([33071, 33648, 10497]);

/**
 * Count the bytes of an uncompressed RGBA texture and, when it generates them, its mipmaps.
 * @param size - The texture's pixel dimensions.
 * @param size.width - Its width in pixels.
 * @param size.height - Its height in pixels.
 * @param mipmaps - Whether the texture generates mipmaps.
 * @returns The byte count.
 * @throws {never} Never.
 */
function rgbaBytes(size: ImageSize, mipmaps: boolean): number {
  let { width, height } = size;
  let total = 0;
  while (true) {
    total += width * height * 4;
    if (!mipmaps || (width === 1 && height === 1)) return total;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

/**
 * Hold the texture bytes every browser that can open the model uploads to the cumulative budget, from the declarations alone,
 * so import and every later open reach the same verdict.
 * GLTFLoader shares one image source per image index, and WebGLRenderer uploads a source once per filter and wrap combination:
 * texture transforms and second UV sets clone a texture without another upload.
 * @param json - The checked glTF document.
 * @param sizes - The declared dimensions of every image any browser decodes, from validateModelTextureMetadata.
 * @param measured - The decoded mip bytes of the compressed (KTX2) images, which every browser decodes from the same image.
 * @param limits - Configured cumulative texture budget.
 * @throws {ModelImportError} When the textures any browser uploads exceed the cumulative budget.
 */
export function validateModelTextureBytes(json: GltfDocument, sizes: ReadonlyMap<number, ImageSize>, measured: ReadonlyMap<number, number>, limits: SceneImportLimits): void {
  const { textures = [], samplers = [] } = json as { textures?: { sampler?: number }[]; samplers?: Record<string, unknown>[] };
  // ponytail: an image used as colour and as data through a cloned texture uploads once per colour space and is counted once;
  // count per material slot colour space if such models exceed the budget on devices.
  const total = Math.max(...loadedResourcesInEveryBrowser(json).map((resources) => {
    const uploads = new Map<string, number>();
    for (const { texture, image } of resources.textures) {
      // inspectModelFiles refused every used texture that names no image.
      if (image === undefined) continue;
      const sampler = samplers[textures[texture]?.sampler ?? -1] ?? {};
      const min = MIN_FILTERS.has(sampler.minFilter) ? sampler.minFilter : 9987;
      const key = [image, MAG_FILTERS.has(sampler.magFilter) ? sampler.magFilter : 9729, min,
        WRAPPINGS.has(sampler.wrapS) ? sampler.wrapS : 10497, WRAPPINGS.has(sampler.wrapT) ? sampler.wrapT : 10497].join();
      uploads.set(key, measured.get(image) ?? rgbaBytes(sizes.get(image)!, min !== 9728 && min !== 9729));
    }
    return [...uploads.values()].reduce((sum, bytes) => sum + bytes, 0);
  }));
  if (total > limits.maxTextureBytes) {
    throw new ModelImportError('budget', 'Model textures exceed the configured cumulative budget', { detail: '',
      budget: { limit: 'textureBytes', allowed: limits.maxTextureBytes, actual: total } });
  }
}

/**
 * Name an image for the user: its path when it is a file, otherwise its index.
 * @param model - Checked original glTF resources.
 * @param index - The image's index.
 * @returns The resolved file path, or `images[N]` for embedded images.
 * @throws {ModelImportError} When the image URI is malformed.
 */
export function imageLocation(model: ModelPackage, index: number): string {
  const uri = loadedImageUri(model.json.images?.[index]);
  return uri !== undefined && !uri.startsWith('data:') ? resolveModelDependency(model.entry, uri) : `images[${index}]`;
}
