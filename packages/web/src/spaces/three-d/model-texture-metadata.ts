// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { imageDimensionsFromData } from 'image-dimensions';
import type { SceneImportLimits } from '@breatic/shared';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { readModelResource, resolveModelDependency } from '@web/spaces/three-d/model-package';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { loadedResources } from '@web/spaces/three-d/model-loaded-resources';

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

/**
 * Read one image's declared dimensions and hold them to the edge budget.
 * @param read - The model, the decoded data URIs and the image location.
 * @param image - The glTF image declaration.
 * @param limits - Configured and device-adjusted texture dimension budget.
 * @throws {ModelImportError} When the image is invalid or exceeds its dimension budget.
 */
function checkImage(read: ImageRead, image: NonNullable<ModelPackage['json']['images']>[number], limits: SceneImportLimits): void {
  const { location } = read;
  // GLTFLoader.loadImageSource reads an image's bufferView whenever it has one, and its URI only otherwise.
  const bytes = image.bufferView !== undefined ? readImageView(read, image.bufferView)
    : image.uri !== undefined ? readModelResource(read.model, image.uri, read.location, read.decoded) : undefined;
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
}

/**
 * Check the dimensions of the images GLTFLoader decodes, before the browser decodes their pixels.
 * A failure names the image by its file path, or by its index when the image is embedded.
 * @param model - Checked original glTF resources.
 * @param limits - Configured and device-adjusted texture dimension budget.
 * @throws {ModelImportError} When an image is invalid or exceeds its dimension budget.
 */
export function validateModelTextureMetadata(model: ModelPackage, limits: SceneImportLimits): void {
  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  // loadedResources lists only images that exist.
  for (const index of loadedResources(model.json, model.support).images) checkImage({ model, decoded, location: imageLocation(model, index) }, model.json.images![index], limits);
}

/**
 * Name an image for the user: its path when it is a file, otherwise its index.
 * @param model - Checked original glTF resources.
 * @param index - The image's index.
 * @returns The resolved file path, or `images[N]` for embedded images.
 * @throws {ModelImportError} When the image URI is malformed.
 */
export function imageLocation(model: ModelPackage, index: number): string {
  const uri = model.json.images?.[index]?.uri;
  return uri !== undefined && !uri.startsWith('data:') && model.json.images?.[index]?.bufferView === undefined ? resolveModelDependency(model.entry, uri) : `images[${index}]`;
}
