// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { imageDimensionsFromData } from 'image-dimensions';
import type { SceneImportLimits } from '@breatic/shared';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { resolveModelDependency } from '@web/spaces/three-d/model-package';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** Everything one image check reads: the model, its decoded data URIs and the image's location for failures. */
interface ImageRead {
  model: ModelPackage;
  /** Data URIs decoded during this validation; images that share an embedded buffer decode it once. */
  decoded: Map<string, Uint8Array<ArrayBuffer>>;
  location: string;
}

/**
 * Read an embedded URI or an original file from the closed model collection.
 * @param read - The model, the decoded data URIs and the image location.
 * @param uri - Image or buffer URI relative to the model entry.
 * @returns The original resource bytes.
 * @throws {ModelImportError} When embedded resource bytes cannot be decoded.
 */
function readResource(read: ImageRead, uri: string): Uint8Array<ArrayBuffer> {
  if (uri.startsWith('data:')) {
    const cached = read.decoded.get(uri);
    if (cached) return cached;
    const comma = uri.indexOf(',');
    if (comma < 0) throw new ModelImportError('invalid', 'Invalid embedded model resource', { detail: read.location });
    const encoded = uri.slice(comma + 1).replace(/%([a-f\d]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    let binary: string;
    try {
      binary = /;base64$/i.test(uri.slice(0, comma)) ? atob(encoded) : encoded;
    } catch {
      throw new ModelImportError('invalid', 'Invalid embedded model resource', { detail: read.location });
    }
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    read.decoded.set(uri, bytes);
    return bytes;
  }
  const path = resolveModelDependency(read.model.entry, uri);
  // inspectModelFiles establishes resource presence before either parsing entry point.
  return read.model.files.get(path)!;
}

/**
 * Locate the original GLB BIN chunk without copying its image payload.
 * @param read - The checked binary model entry and the image location.
 * @returns A byte view of the embedded buffer.
 * @throws {ModelImportError} When the container or its binary chunk is invalid.
 */
function readBinaryChunk(read: ImageRead): Uint8Array<ArrayBuffer> {
  const { model, location } = read;
  const bytes = model.files.get(model.entry);
  if (!bytes || !model.entry.toLowerCase().endsWith('.glb')) throw new ModelImportError('invalid', 'Model image has no embedded binary buffer', { detail: location });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset < bytes.byteLength;) {
    if (bytes.byteLength - offset < 8) throw new ModelImportError('invalid', 'Truncated binary model chunk', { detail: location });
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || length > bytes.byteLength - offset) throw new ModelImportError('invalid', 'Invalid binary model chunk length', { detail: location });
    if (type === 0x004e4942) return bytes.subarray(offset, offset + length);
    offset += length;
  }
  throw new ModelImportError('invalid', 'Model image has no embedded binary buffer', { detail: location });
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
  if (buffer.uri === undefined && view.buffer !== 0) throw new ModelImportError('invalid', 'Only the first model buffer can be embedded', { detail: location });
  const bytes = buffer.uri === undefined ? readBinaryChunk(read) : readResource(read, buffer.uri);
  if (buffer.byteLength > bytes.byteLength) throw new ModelImportError('invalid', 'Truncated model image buffer', { detail: location });
  return bytes.subarray(offset, offset + view.byteLength);
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
  const bytes = image.uri !== undefined ? readResource(read, image.uri)
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
}

/**
 * Check declared image dimensions before the browser decodes texture pixels.
 * A failure names the image by its file path, or by its index when the image is embedded.
 * @param model - Checked original glTF resources.
 * @param limits - Configured and device-adjusted texture dimension budget.
 * @throws {ModelImportError} When an image is invalid or exceeds its dimension budget.
 */
export function validateModelTextureMetadata(model: ModelPackage, limits: SceneImportLimits): void {
  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [index, image] of (model.json.images ?? []).entries()) checkImage({ model, decoded, location: imageLocation(model, index) }, image, limits);
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
  return uri !== undefined && !uri.startsWith('data:') ? resolveModelDependency(model.entry, uri) : `images[${index}]`;
}
