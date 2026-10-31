// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { inspectModelFiles } from '@web/spaces/three-d/model-package';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { validateModelTextureMetadata } from '@web/spaces/three-d/model-texture-metadata';

const ENTRY = 'models/scene.gltf';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));

/**
 * Create metadata dimensions without allocating decoded pixel storage.
 * @param width - The PNG header width.
 * @param height - The PNG header height.
 * @returns Original PNG bytes with the requested IHDR dimensions.
 * @throws {never} Never directly.
 */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(PNG);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * Build a KTX2 header whose GPU payload is deliberately outside this API.
 * @param width - The container's pixel width.
 * @param height - The container's pixel height.
 * @returns The fixed metadata header.
 * @throws {never} Never directly.
 */
function ktx2(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(80);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, 37, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  return bytes;
}

/**
 * Pass every fixture through the real glTF envelope and dependency checker.
 * @param json - The glTF declarations relevant to metadata lookup.
 * @param resources - Original resources beside the model entry.
 * @returns A checked model package.
 * @throws {Error} When the fixture's entry or dependencies are invalid.
 */
function model(json: Record<string, unknown>, resources: readonly (readonly [string, Uint8Array<ArrayBuffer>])[] = []): ModelPackage {
  const entry = Uint8Array.from(new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...json })));
  return inspectModelFiles(new Map([[ENTRY, entry], ...resources]), ENTRY, IMPORT_LIMITS);
}

/**
 * Keep the original resource path distinct from the URI's encoded spelling.
 * @param bytes - The declared texture's original bytes.
 * @param mimeType - The glTF texture MIME declaration.
 * @returns The inspected external-image model.
 * @throws {Error} When the fixture is invalid.
 */
function externalImage(bytes: Uint8Array<ArrayBuffer>, mimeType = 'image/png'): ModelPackage {
  return model({ images: [{ uri: 'textures/Character%20Color', mimeType }] }, [
    ['models/textures/Character Color', bytes],
  ]);
}

/**
 * Encode a local byte sequence in a self-contained glTF URI.
 * @param bytes - The source bytes.
 * @param mimeType - The URI media type.
 * @returns A base64 data URI.
 * @throws {never} Never directly.
 */
function dataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${btoa(String.fromCharCode(...bytes))}`;
}

/**
 * Build a GLB whose image occupies a nonzero bufferView and BIN offset.
 * @param image - Image bytes referenced by the second view.
 * @returns A checked GLB package.
 * @throws {Error} When the generated GLB envelope is invalid.
 */
function embeddedGlb(image: Uint8Array<ArrayBuffer>): ModelPackage {
  const offset = 32;
  const binary = new Uint8Array(offset + image.byteLength + 12);
  binary.fill(0x7f);
  binary.set(image, offset);
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 },
      { buffer: 0, byteOffset: offset, byteLength: image.byteLength },
    ],
    images: [{ bufferView: 1, mimeType: 'image/png' }],
  }));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const binaryLength = Math.ceil(binary.byteLength / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(json, 20);
  view.setUint32(20 + jsonLength, binaryLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(binary, 28 + jsonLength);
  return inspectModelFiles(new Map([['scene.glb', bytes]]), 'scene.glb', IMPORT_LIMITS);
}

describe('model texture metadata dimensions before decoding', () => {
  it.each([[32, 16], [16, 32]])('accepts a PNG at its largest %s by %s dimension and refuses N-1', (width, height) => {
    const source = externalImage(png(width, height));
    const edge = Math.max(width, height);

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: edge })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: edge - 1 })).toThrow(Error);
  });

  it('checks dimensions inside image data URIs', () => {
    const source = model({ images: [{ uri: dataUri(png(32, 16), 'image/png') }] });

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 32 })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
  });

  it('checks GLB images at the referenced bufferView and BIN byte offset', () => {
    const source = embeddedGlb(png(16, 32));

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 32 })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
  });

  it('locates image bufferViews in their declared external buffer', () => {
    const image = png(32, 16);
    const buffer = new Uint8Array(24 + image.byteLength);
    buffer.set(image, 24);
    const source = model({
      buffers: [{ uri: 'unused.bin', byteLength: 8 }, { uri: 'images.bin', byteLength: buffer.byteLength }],
      bufferViews: [{ buffer: 1, byteOffset: 24, byteLength: image.byteLength }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
    }, [['models/unused.bin', new Uint8Array(8)], ['models/images.bin', buffer]]);

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 32 })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
  });

  it('reads image bufferViews from an embedded buffer data URI', () => {
    const image = png(32, 16);
    const buffer = new Uint8Array(12 + image.byteLength);
    buffer.set(image, 12);
    const source = model({
      buffers: [{ uri: dataUri(buffer, 'application/octet-stream'), byteLength: buffer.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 12, byteLength: image.byteLength }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
    });

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 32 })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
  });

  it.each([
    ['JPEG', 'exif6.jpg', 'image/jpeg'],
    ['WebP', 'exif6-red-top.webp', 'image/webp'],
  ])('reads the existing %s fixture at its 1024-pixel longest edge', (_format, filename, mimeType) => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures', filename);
    const image = Uint8Array.from(readFileSync(path));
    const source = externalImage(image, mimeType);

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 1024 })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 1023 })).toThrow(Error);
  });

  it('checks KTX2 dimensions without estimating its decoded allocation from RGBA', () => {
    const source = externalImage(ktx2(32, 16), 'image/ktx2');
    const limits = { ...IMPORT_LIMITS, maxTextureEdge: 32, maxTextureBytes: 1 };

    expect(() => validateModelTextureMetadata(source, limits)).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...limits, maxTextureEdge: 31 })).toThrow(Error);
  });

  it('checks an image even when no material or texture references it', () => {
    const source = model({ images: [{ uri: 'small.png' }, { uri: 'unused.png' }] }, [
      ['models/small.png', png(1, 1)], ['models/unused.png', png(32, 16)],
    ]);

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
  });

  it.each([{}, { images: [] }])('accepts a model without image declarations: %j', (json) => {
    expect(() => validateModelTextureMetadata(model(json), IMPORT_LIMITS)).not.toThrow();
  });

  it('uses the resource byte view rather than its larger backing ArrayBuffer', () => {
    const image = png(32, 16);
    const backing = new Uint8Array(40 + image.byteLength);
    backing.set(image, 40);
    const source = externalImage(backing.subarray(40));

    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 32 })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
  });

  it('preserves the original resource paths and bytes on success and refusal', () => {
    const source = externalImage(png(32, 16));
    const before = new Map([...source.files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));

    validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 32 });
    expect(source.files).toEqual(before);
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
    expect(source.files).toEqual(before);
  });
});

describe('model texture buffer metadata validation', () => {
  it.each([-1, 0.5, 5])('rejects an invalid image bufferView index %s', (bufferView) => {
    const source = model({ images: [{ bufferView }], bufferViews: [] });
    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });

  it.each([undefined, -1, 0.5])('rejects an invalid declared buffer length %s', (byteLength) => {
    const image = png(1, 1);
    const source = model({ buffers: [{ uri: 'image.bin', byteLength }],
      bufferViews: [{ buffer: 0, byteLength: image.length }], images: [{ bufferView: 0 }] }, [['models/image.bin', image]]);
    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });

  it('rejects an actual buffer shorter than its declaration', () => {
    const image = png(1, 1);
    const source = model({ buffers: [{ uri: 'image.bin', byteLength: image.length + 1 }],
      bufferViews: [{ buffer: 0, byteLength: image.length }], images: [{ bufferView: 0 }] }, [['models/image.bin', image]]);
    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });

  it.each(['missing-bin', 'truncated-header', 'unaligned-bin', 'oversized-bin'] as const)('rejects a GLB image with %s', (problem) => {
    const original = embeddedGlb(png(1, 1)).files.get('scene.glb')!;
    const jsonLength = new DataView(original.buffer, original.byteOffset, original.byteLength).getUint32(12, true);
    const end = 20 + jsonLength;
    const bytes = problem === 'missing-bin' ? original.slice(0, end)
      : problem === 'truncated-header' ? original.slice(0, end + 1) : original.slice();
    const header = new DataView(bytes.buffer);
    header.setUint32(8, bytes.length, true);
    if (problem === 'unaligned-bin') header.setUint32(end, 1, true);
    if (problem === 'oversized-bin') header.setUint32(end, bytes.length, true);
    const source = inspectModelFiles(new Map([['scene.glb', bytes]]), 'scene.glb', IMPORT_LIMITS);
    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });

  it('reads percent-encoded image bytes without changing the original URI', () => {
    const uri = `data:image/png,${Array.from(png(32, 16), (byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')}`;
    const source = model({ images: [{ uri }] });
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 32 })).not.toThrow();
    expect(() => validateModelTextureMetadata(source, { ...IMPORT_LIMITS, maxTextureEdge: 31 })).toThrow(Error);
    expect(source.json.images?.[0].uri).toBe(uri);
  });

  it.each([
    { images: [{}] },
    { images: [{ uri: 'data:image/png;base64' }] },
    { buffers: [{ byteLength: PNG.length }], bufferViews: [{ buffer: 0, byteLength: PNG.length }], images: [{ bufferView: 0 }] },
    { buffers: [{ uri: 'data:application/octet-stream;base64,AA==', byteLength: 1 }, { byteLength: 1 }],
      bufferViews: [{ buffer: 1, byteLength: 1 }], images: [{ bufferView: 0 }] },
  ])('rejects an incomplete image source %j', (json) => {
    expect(() => validateModelTextureMetadata(model(json), IMPORT_LIMITS)).toThrow(Error);
  });

  it.each([png(0, 1), png(1, 0), ktx2(0, 1), ktx2(1, 0), ktx2(1, 1).slice(0, 40)])('rejects invalid or truncated image dimensions', (image) => {
    expect(() => validateModelTextureMetadata(externalImage(image), IMPORT_LIMITS)).toThrow(Error);
  });

  it.each([
    { label: 'negative offset', view: { buffer: 0, byteOffset: -1, byteLength: 20 } },
    { label: 'fractional offset', view: { buffer: 0, byteOffset: 0.5, byteLength: 20 } },
    { label: 'negative length', view: { buffer: 0, byteOffset: 0, byteLength: -1 } },
    { label: 'fractional length', view: { buffer: 0, byteOffset: 0, byteLength: 20.5 } },
    { label: 'out-of-bounds offset', view: { buffer: 0, byteOffset: 1000, byteLength: 20 } },
    { label: 'out-of-bounds end', view: { buffer: 0, byteOffset: 40, byteLength: 1000 } },
    { label: 'missing buffer index', view: { buffer: 1, byteOffset: 0, byteLength: 20 } },
  ])('rejects an image view with $label', ({ view }) => {
    const image = png(1, 1);
    const source = model({
      buffers: [{ uri: 'image.bin', byteLength: image.byteLength }], bufferViews: [view],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
    }, [['models/image.bin', image]]);

    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });

  it('rejects an image view beyond the declared buffer length', () => {
    const image = png(1, 1);
    const source = model({
      buffers: [{ uri: 'image.bin', byteLength: 8 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.byteLength }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
    }, [['models/image.bin', image]]);

    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });

  it('rejects an image whose bufferView does not exist', () => {
    const source = model({ images: [{ bufferView: 5, mimeType: 'image/png' }], bufferViews: [] });

    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });

  it('rejects a truncated PNG header before any pixel decoding', () => {
    const source = externalImage(PNG.slice(0, 16));

    expect(() => validateModelTextureMetadata(source, IMPORT_LIMITS)).toThrow(Error);
  });
});
