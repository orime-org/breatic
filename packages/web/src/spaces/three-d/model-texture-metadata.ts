// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { imageDimensionsFromData } from 'image-dimensions';
import type { SceneImportLimits } from '@breatic/shared';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { resolveModelDependency } from '@web/spaces/three-d/model-package';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read an embedded URI or an original file from the closed model collection.
 * @param model - Checked model entry and original resources.
 * @param uri - Image or buffer URI relative to the model entry.
 * @returns The original resource bytes.
 * @throws {Error} When embedded resource bytes cannot be decoded.
 */
function readResource(model: ModelPackage, uri: string): Uint8Array<ArrayBuffer> {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0) throw new ModelImportError('invalid', 'Invalid embedded model resource');
    const encoded = uri.slice(comma + 1).replace(/%([a-f\d]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    const binary = /;base64$/i.test(uri.slice(0, comma)) ? atob(encoded) : encoded;
    return Uint8Array.from(binary, (value) => value.charCodeAt(0));
  }
  const path = resolveModelDependency(model.entry, uri);
  // inspectModelFiles establishes resource presence before either parsing entry point.
  return model.files.get(path)!;
}

/**
 * Locate the original GLB BIN chunk without copying its image payload.
 * @param model - Checked binary model entry.
 * @returns A byte view of the embedded buffer.
 * @throws {ModelImportError} When the container or its binary chunk is invalid.
 */
function readBinaryChunk(model: ModelPackage): Uint8Array<ArrayBuffer> {
  const bytes = model.files.get(model.entry);
  if (!bytes || !model.entry.toLowerCase().endsWith('.glb')) throw new ModelImportError('invalid', 'Model image has no embedded binary buffer');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset < bytes.byteLength;) {
    if (bytes.byteLength - offset < 8) throw new ModelImportError('invalid', 'Truncated binary model chunk');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || length > bytes.byteLength - offset) throw new ModelImportError('invalid', 'Invalid binary model chunk length');
    if (type === 0x004e4942) return bytes.subarray(offset, offset + length);
    offset += length;
  }
  throw new ModelImportError('invalid', 'Model image has no embedded binary buffer');
}

/**
 * Resolve an image view within both the actual and declared buffer bounds.
 * @param model - Original glTF declarations and resources.
 * @param index - Image's declared bufferView index.
 * @returns The original image byte view.
 * @throws {ModelImportError} When an index, offset or declared range is invalid.
 */
function readImageView(model: ModelPackage, index: number): Uint8Array<ArrayBuffer> {
  const view = Number.isSafeInteger(index) && index >= 0 ? model.json.bufferViews?.[index] : undefined;
  if (!view || !Number.isSafeInteger(view.buffer) || view.buffer < 0) throw new ModelImportError('invalid', 'Invalid model image buffer view');
  const buffer = model.json.buffers?.[view.buffer];
  if (!buffer || buffer.byteLength === undefined || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0) {
    throw new ModelImportError('invalid', 'Invalid model image buffer');
  }
  const offset = view.byteOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength <= 0
    || offset > buffer.byteLength || view.byteLength > buffer.byteLength - offset) {
    throw new ModelImportError('invalid', 'Model image view exceeds its declared buffer');
  }
  if (buffer.uri === undefined && view.buffer !== 0) throw new ModelImportError('invalid', 'Only the first model buffer can be embedded');
  const bytes = buffer.uri === undefined ? readBinaryChunk(model) : readResource(model, buffer.uri);
  if (buffer.byteLength > bytes.byteLength) throw new ModelImportError('invalid', 'Truncated model image buffer');
  return bytes.subarray(offset, offset + view.byteLength);
}

/**
 * Check declared image dimensions before the browser decodes texture pixels.
 * @param model - Checked original glTF resources.
 * @param limits - Configured and device-adjusted texture dimension budget.
 * @throws {Error} When an image is invalid or exceeds its dimension budget.
 */
export function validateModelTextureMetadata(model: ModelPackage, limits: SceneImportLimits): void {
  for (const image of model.json.images ?? []) {
    const bytes = image.uri !== undefined ? readResource(model, image.uri)
      : image.bufferView !== undefined ? readImageView(model, image.bufferView) : undefined;
    if (!bytes) throw new ModelImportError('invalid', 'Model image has no source');
    let dimensions: { width: number; height: number } | undefined;
    if (KTX2_IDENTIFIER.every((value, index) => bytes[index] === value)) {
      if (bytes.byteLength < 80) throw new ModelImportError('invalid', 'Truncated KTX2 image header');
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      dimensions = { width: header.getUint32(20, true), height: header.getUint32(24, true) };
    } else dimensions = imageDimensionsFromData(bytes);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) throw new ModelImportError('invalid', 'Invalid model image metadata');
    if (Math.max(dimensions.width, dimensions.height) > limits.maxTextureEdge) {
      throw new ModelImportError('budget', 'Model texture exceeds its configured dimension budget', undefined, image.uri ?? `bufferView ${image.bufferView}`);
    }
  }
}
