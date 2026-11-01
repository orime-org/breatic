// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8, unzipSync, zipSync } from 'three/addons/libs/fflate.module.js';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import {
  inspectModelFiles, normalizeModelPath, packModelFiles, readModelJson,
  readRegisteredModelPackage, resolveModelDependency, unpackModelArchive,
} from '@web/spaces/three-d/model-package';

const ENTRY = 'character/scene.gltf';
const GEOMETRY = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
const IMAGE = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));

/**
 * Keep fixture arrays in the same realm as the ZIP encoder's file detection.
 * @throws {never} Never.
 */
function textBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(strToU8(value));
}

/**
 * Describe a valid model whose resource URIs belong to the selected collection.
 * @throws {never} Never.
 */
function gltfDocument(bufferUri: string, imageUri?: string, name = 'Original model'): Record<string, unknown> {
  return {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...(imageUri !== undefined && { material: 0 }) }] }],
    buffers: [{ uri: bufferUri, byteLength: GEOMETRY.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: GEOMETRY.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    ...(imageUri !== undefined && {
      images: [{ uri: imageUri }], textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.7 } }],
    }),
    extras: { retained: 'Original cafe\u0301 metadata' },
  };
}

/**
 * Encode a self-contained GLB while preserving the producer's padded JSON chunk.
 * @throws {never} Never.
 */
function glb(name = 'Original model'): Uint8Array<ArrayBuffer> {
  const encodedGeometry = btoa(String.fromCharCode(...GEOMETRY));
  const json = textBytes(JSON.stringify(gltfDocument(`data:application/octet-stream;base64,${encodedGeometry}`, undefined, name)));
  const length = Math.ceil(json.byteLength / 4) * 4;
  const bytes = new Uint8Array(20 + length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20);
  bytes.set(json, 20);
  return bytes;
}

/**
 * Include geometry, texture and user metadata as distinct original files.
 * @throws {never} Never.
 */
function sourceFiles(): Map<string, Uint8Array<ArrayBuffer>> {
  return new Map([
    [ENTRY, textBytes(JSON.stringify(gltfDocument('mesh.bin', 'textures/Base%20Color.png'), null, 2) + '\r\n')],
    ['character/mesh.bin', GEOMETRY],
    ['character/textures/Base Color.png', IMAGE],
    ['manifest.json', textBytes('{ "userMetadata": true }\n')],
  ]);
}

/**
 * Produce external ZIP input independently of the production model-package writer.
 * @throws {Error} When the ZIP fixture cannot be encoded.
 */
function archive(files: ReadonlyMap<string, Uint8Array>, level: 0 | 6 = 0): Uint8Array<ArrayBuffer> {
  const entries = Object.fromEntries([...files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
  return Uint8Array.from(zipSync(entries, { level }));
}

describe('model-package original content and entry contract (inner#1690)', () => {
  it('keeps a single self-contained GLB byte-for-byte, including arbitrary model metadata', () => {
    fc.assert(fc.property(fc.string(), (name) => {
      const original = glb(name);
      const packed = packModelFiles(new Map([['model.glb', original]]), 'model.glb', IMPORT_LIMITS);
      expect(Array.from(packed)).toEqual(Array.from(original));
    }));
  });

  it('keeps both selected GLBs in a ZIP and records the chosen second model as its entry', () => {
    const first = glb('First model');
    const second = glb('Selected model');
    const packed = packModelFiles(new Map([['first.glb', first], ['second.glb', second]]), 'second.glb', IMPORT_LIMITS);
    const files = unzipSync(packed);

    expect(Object.keys(files).sort()).toEqual(['files/first.glb', 'files/second.glb', 'manifest.json']);
    expect(JSON.parse(strFromU8(files['manifest.json']))).toEqual({ formatVersion: 1, entryPath: 'files/second.glb' });
    expect(Array.from(files['files/first.glb'])).toEqual(Array.from(first));
    expect(Array.from(files['files/second.glb'])).toEqual(Array.from(second));
  });

  it('produces identical complete ZIP bytes for every ordering of the same chosen files', () => {
    const files = [...sourceFiles()];
    const expected = packModelFiles(new Map(files), ENTRY, IMPORT_LIMITS);
    fc.assert(fc.property(fc.shuffledSubarray(files, { minLength: files.length, maxLength: files.length }), (order) => {
      expect(Array.from(packModelFiles(new Map(order), ENTRY, IMPORT_LIMITS))).toEqual(Array.from(expected));
    }));
    const unpacked = unzipSync(expected);
    expect(JSON.parse(strFromU8(unpacked['manifest.json']))).toEqual({ formatVersion: 1, entryPath: `files/${ENTRY}` });
  });

  it('preserves glTF, geometry, texture and an existing user manifest as separate original bytes', () => {
    const original = sourceFiles();
    const packed = packModelFiles(original, ENTRY, IMPORT_LIMITS);
    const unpacked = unzipSync(packed);

    expect(Object.keys(unpacked).sort()).toEqual([...original.keys()].map((path) => `files/${path}`).concat('manifest.json').sort());
    for (const [path, bytes] of original) expect(Array.from(unpacked[`files/${path}`])).toEqual(Array.from(bytes));
    const registered = readRegisteredModelPackage(packed, IMPORT_LIMITS);
    expect(registered.json).toEqual(JSON.parse(strFromU8(original.get(ENTRY)!)));
    expect(Array.from(registered.files.get(registered.entry)!)).toEqual(Array.from(original.get(ENTRY)!));
  });

  it('preserves an arbitrary selected resource together with a self-contained model', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (resource) => {
      const original = glb();
      const packed = packModelFiles(new Map([['model.glb', original], ['resource.bin', Uint8Array.from(resource)]]), 'model.glb', IMPORT_LIMITS);
      const unpacked = unzipSync(packed);
      expect(Object.keys(unpacked).sort()).toEqual(['files/model.glb', 'files/resource.bin', 'manifest.json']);
      expect(Array.from(unpacked['files/model.glb'])).toEqual(Array.from(original));
      expect(Array.from(unpacked['files/resource.bin'])).toEqual(Array.from(resource));
    }));
  });
});

describe('model resource paths and dependencies', () => {
  it.each([
    ['character/./props/../model.glb', 'character/model.glb'],
    ['character\\props\\..\\model.glb', 'character/model.glb'],
    ['./character/model.glb', 'character/model.glb'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeModelPath(input)).toBe(expected);
  });

  it.each(['../model.glb', '/character/model.glb', 'character/../../model.glb', '', '.', 'https://external.example/model.glb', '\\model.glb', 'invalid\0.glb'])('rejects a file path outside the collection: %s', (path) => {
    expect(() => normalizeModelPath(path)).toThrow(Error);
  });

  it.each([
    ['character/scene.gltf', 'textures/Base%20Color.png', 'character/textures/Base Color.png'],
    ['character/scene.gltf', '../textures/blue%23green.png', 'textures/blue#green.png'],
    ['character/scene.gltf', 'textures\\Base%20Color.png', 'character/textures/Base Color.png'],
  ])('resolves %s with %s to %s', (entry, uri, expected) => {
    expect(resolveModelDependency(entry, uri)).toBe(expected);
  });

  it.each(['../mesh.bin', '%2e%2e/mesh.bin', 'https://example.com/mesh.bin'])('refuses a resource outside the collection: %s', (uri) => {
    expect(() => resolveModelDependency('scene.gltf', uri)).toThrow(Error);
  });

  it.each(['character/./mesh.bin', 'character\\mesh.bin'])('refuses ZIP entries that normalize to the same path: %s', (alias) => {
    const bytes = archive(new Map([['character/mesh.bin', new Uint8Array([1])], [alias, new Uint8Array([2])]]));
    expect(() => unpackModelArchive(bytes, IMPORT_LIMITS)).toThrow(Error);
  });

  it('locates a missing dependency in the selected source collection', () => {
    const files = sourceFiles();
    files.delete('character/mesh.bin');
    expect(() => inspectModelFiles(files, ENTRY, IMPORT_LIMITS)).toThrow('mesh.bin');
  });

  it('accepts data URI geometry without requiring an external file', () => {
    const encodedGeometry = btoa(String.fromCharCode(...GEOMETRY));
    const original = textBytes(JSON.stringify(gltfDocument(`data:application/octet-stream;base64,${encodedGeometry}`)));
    const model = inspectModelFiles(new Map([['scene.gltf', original]]), 'scene.gltf', IMPORT_LIMITS);
    expect(model.entry).toBe('scene.gltf');
    expect(model.json).toEqual(JSON.parse(strFromU8(original)));
    expect([...model.files.keys()]).toEqual(['scene.gltf']);
  });
});

describe('model-package configurable budget boundaries', () => {
  it('accepts an input ZIP exactly at its byte budget and refuses the next lower budget', () => {
    const original = new Map([['a.bin', new Uint8Array([1, 2, 3])]]);
    const bytes = archive(original);
    const limits = { ...IMPORT_LIMITS, maxInputBytes: bytes.byteLength };

    expect(unpackModelArchive(bytes, limits)).toEqual(original);
    expect(() => unpackModelArchive(bytes, { ...limits, maxInputBytes: bytes.byteLength - 1 })).toThrow(Error);
  });

  it('checks cumulative expanded bytes at the exact limit across multiple ZIP entries', () => {
    const original = new Map([['a.bin', new Uint8Array(33)], ['b.bin', new Uint8Array(17)]]);
    const bytes = archive(original, 6);
    const limits = { ...IMPORT_LIMITS, maxExpandedBytes: 50 };

    expect(unpackModelArchive(bytes, limits)).toEqual(original);
    expect(() => unpackModelArchive(bytes, { ...limits, maxExpandedBytes: 49 })).toThrow(Error);
  });

  it('accepts exactly the configured file count and rejects one fewer allowed file', () => {
    const original = new Map([['a.bin', new Uint8Array([1])], ['b.bin', new Uint8Array([2])]]);
    const bytes = archive(original);
    const limits = { ...IMPORT_LIMITS, maxFiles: 2 };

    expect(unpackModelArchive(bytes, limits)).toEqual(original);
    expect(() => unpackModelArchive(bytes, { ...limits, maxFiles: 1 })).toThrow(Error);
  });

  it('includes ZIP headers and the manifest in the generated artifact byte budget', () => {
    const original = sourceFiles();
    const expected = packModelFiles(original, ENTRY, IMPORT_LIMITS);
    const limits = { ...IMPORT_LIMITS, maxArtifactBytes: expected.byteLength };

    expect(Array.from(packModelFiles(original, ENTRY, limits))).toEqual(Array.from(expected));
    expect(() => packModelFiles(original, ENTRY, { ...limits, maxArtifactBytes: expected.byteLength - 1 })).toThrow(Error);
  });

  it('applies the artifact byte budget to a GLB returned without ZIP wrapping', () => {
    const original = glb();
    const files = new Map([['model.glb', original]]);
    const limits = { ...IMPORT_LIMITS, maxArtifactBytes: original.byteLength };

    expect(Array.from(packModelFiles(files, 'model.glb', limits))).toEqual(Array.from(original));
    expect(() => packModelFiles(files, 'model.glb', { ...limits, maxArtifactBytes: original.byteLength - 1 })).toThrow(Error);
  });

  it('uses the registered artifact budget when a packaged asset is larger than the local selection budget', () => {
    const bytes = packModelFiles(sourceFiles(), ENTRY, IMPORT_LIMITS);
    const limits = { ...IMPORT_LIMITS, maxInputBytes: 1, maxArtifactBytes: bytes.byteLength };
    const model = readRegisteredModelPackage(bytes, limits);

    expect(model.json.asset.version).toBe('2.0');
    expect(Array.from(model.files.get(model.entry)!)).toEqual(Array.from(sourceFiles().get(ENTRY)!));
    expect(() => readRegisteredModelPackage(bytes, { ...limits, maxArtifactBytes: bytes.byteLength - 1 })).toThrow(Error);
  });

  it('checks source file and expanded-byte budgets before packaging', () => {
    const files = sourceFiles();
    const size = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    expect(() => packModelFiles(files, ENTRY, { ...IMPORT_LIMITS, maxFiles: files.size - 1 })).toThrow(Error);
    expect(() => packModelFiles(files, ENTRY, { ...IMPORT_LIMITS, maxExpandedBytes: size - 1 })).toThrow(Error);
    const manifest = textBytes(JSON.stringify({ formatVersion: 1, entryPath: `files/${ENTRY}` }));
    expect(() => packModelFiles(files, ENTRY, { ...IMPORT_LIMITS, maxExpandedBytes: size + manifest.length - 1 })).toThrow(Error);
  });

  it('rejects noncanonical original resource paths at the package boundary', () => {
    const files = sourceFiles();
    files.set('./notes.txt', textBytes('Original notes'));
    expect(() => packModelFiles(files, ENTRY, IMPORT_LIMITS)).toThrow('Invalid model resource path');
  });

  it('packages a valid empty glTF envelope without buffer or image declarations', () => {
    const original = textBytes('{"asset":{"version":"2.0"}}');
    const bytes = packModelFiles(new Map([['scene.gltf', original]]), 'scene.gltf', IMPORT_LIMITS);
    expect(Array.from(readRegisteredModelPackage(bytes, IMPORT_LIMITS).files.get('files/scene.gltf')!)).toEqual(Array.from(original));
  });

  it('ignores ZIP directory records while retaining original file bytes', () => {
    const original = glb();
    const bytes = archive(new Map([['folder/', new Uint8Array()], ['folder/model.glb', original]]));
    expect(unpackModelArchive(bytes, IMPORT_LIMITS)).toEqual(new Map([['folder/model.glb', original]]));
  });

  it('rejects oversized declared entries and damaged DEFLATE streams', () => {
    const bytes = archive(new Map([['large.bin', new Uint8Array(1000)]]), 6);
    expect(() => unpackModelArchive(bytes, { ...IMPORT_LIMITS, maxExpandedBytes: 999 })).toThrow(Error);
    const corrupt = bytes.slice();
    const header = new DataView(corrupt.buffer);
    const payload = 30 + header.getUint16(26, true) + header.getUint16(28, true);
    corrupt[payload] = 0xff;
    expect(() => unpackModelArchive(corrupt, IMPORT_LIMITS)).toThrow(Error);
    expect(() => unpackModelArchive(bytes.slice(0, payload + 1), IMPORT_LIMITS)).toThrow(Error);
  });

  it('reads data-descriptor entries whose bytes contain ZIP signatures by their central-directory sizes', () => {
    const texture = new Uint8Array(4096);
    for (let index = 0; index < texture.length; index += 1) texture[index] = (index * 131 + 17) & 0xff;
    texture.set([0x50, 0x4b, 0x03, 0x04], 1000);
    texture.set([0x50, 0x4b, 0x07, 0x08], 2000);
    texture.set([0x50, 0x4b, 0x01, 0x02], 3000);
    for (const Entry of [ZipPassThrough, ZipDeflate]) {
      const parts: Uint8Array[] = [];
      const zip = new Zip((error, chunk) => { if (error) throw error; parts.push(chunk); });
      for (const [name, bytes] of [['model.glb', glb()], ['texture.bin', texture]] as const) {
        const entry = new Entry(name);
        zip.add(entry);
        entry.push(bytes, true);
      }
      zip.end();
      const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
      parts.reduce((offset, part) => { bytes.set(part, offset); return offset + part.byteLength; }, 0);

      expect(Array.from(unpackModelArchive(bytes, IMPORT_LIMITS).get('texture.bin')!), Entry.name).toEqual(Array.from(texture));
    }
  });

  it('refuses an entry whose stored bytes differ from its declared uncompressed size', () => {
    const bytes = archive(new Map([['model.glb', glb()]]));
    const view = new DataView(bytes.buffer);
    let central = bytes.byteLength - 22;
    while (view.getUint32(central, true) !== 0x02014b50) central -= 1;
    view.setUint32(central + 24, view.getUint32(central + 24, true) + 1, true);

    expect(() => unpackModelArchive(bytes, IMPORT_LIMITS)).toThrow(Error);
  });

  it('leaves macOS archive metadata out of the expanded model resources', () => {
    const original = glb();
    const bytes = archive(new Map([
      ['hero/model.glb', original], ['__MACOSX/hero/._model.glb', new Uint8Array([0, 5, 22, 7])],
      ['hero/._model.glb', new Uint8Array([0, 5, 22, 7])], ['hero/.DS_Store', new Uint8Array([0, 0, 0, 1])],
    ]));

    expect(unpackModelArchive(bytes, IMPORT_LIMITS)).toEqual(new Map([['hero/model.glb', original]]));
  });

  it('measures glTF JSON by UTF-8 bytes at the exact configured boundary', () => {
    const encodedGeometry = btoa(String.fromCharCode(...GEOMETRY));
    const document = gltfDocument(`data:application/octet-stream;base64,${encodedGeometry}`, undefined, 'Original caf\u00e9');
    const bytes = textBytes(JSON.stringify(document));
    const limits = { ...IMPORT_LIMITS, maxEntryJsonBytes: bytes.byteLength };

    expect(readModelJson(bytes, 'scene.gltf', limits)).toEqual(document);
    expect(() => readModelJson(bytes, 'scene.gltf', { ...limits, maxEntryJsonBytes: bytes.byteLength - 1 })).toThrow(Error);
  });

  it('measures the declared GLB JSON chunk including its padding at the exact boundary', () => {
    const bytes = glb();
    const jsonBytes = new DataView(bytes.buffer).getUint32(12, true);
    const limits = { ...IMPORT_LIMITS, maxEntryJsonBytes: jsonBytes };

    expect(readModelJson(bytes, 'model.glb', limits).asset.version).toBe('2.0');
    expect(() => readModelJson(bytes, 'model.glb', { ...limits, maxEntryJsonBytes: jsonBytes - 1 })).toThrow(Error);
  });
});

describe('registered model-package zip64 directories (inner#1690)', () => {
  it.each([[10, 0xffff, 2], [16, 0xffffffff, 4]] as const)('refuses a registered package whose end record defers to zip64 at offset %i', (field, marker, width) => {
    const bytes = packModelFiles(new Map([['scene.gltf', textBytes(JSON.stringify(gltfDocument('mesh.bin')))], ['mesh.bin', GEOMETRY.slice()]]), 'scene.gltf', IMPORT_LIMITS);
    const view = new DataView(bytes.buffer);
    let end = bytes.byteLength - 22;
    while (view.getUint32(end, true) !== 0x06054b50) end -= 1;
    if (width === 2) view.setUint16(end + field, marker, true); else view.setUint32(end + field, marker, true);
    expect(() => readRegisteredModelPackage(bytes, IMPORT_LIMITS)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});

describe('registered model-package manifest versions', () => {
  it.each([
    { field: 0, value: 0, reason: 'magic' },
    { field: 4, value: 1, reason: 'version' },
    { field: 8, value: 0, reason: 'container length' },
    { field: 12, value: 1, reason: 'JSON alignment' },
    { field: 12, value: 0xffffffff, reason: 'JSON bounds' },
    { field: 16, value: 0, reason: 'JSON chunk type' },
  ])('refuses invalid GLB $reason', ({ field, value }) => {
    const bytes = glb();
    new DataView(bytes.buffer).setUint32(field, value, true);
    expect(() => readModelJson(bytes, 'model.glb', IMPORT_LIMITS)).toThrow(Error);
  });

  it.each(['unsupported.txt', 'model.gltf'])('refuses an invalid entry envelope in %s', (entry) => {
    expect(() => readModelJson(textBytes('{"asset":{"version":"1.0"}}'), entry, IMPORT_LIMITS)).toThrow(Error);
  });

  it('refuses an absent model entry', () => {
    expect(() => inspectModelFiles(new Map(), 'missing.glb', IMPORT_LIMITS)).toThrow('Missing model entry');
  });

  it.each([
    { files: new Map([['files/model.glb', glb()]]), reason: 'missing manifest' },
    { files: new Map([['files/model.glb', glb()], ['manifest.json', textBytes('{"formatVersion":1,"entryPath":"model.glb"}')]]), reason: 'entry namespace' },
    { files: new Map([['files/model.glb', glb()], ['manifest.json', textBytes('{"formatVersion":1,"entryPath":"files/./model.glb"}')]]), reason: 'noncanonical entry' },
    { files: new Map([['files/model.glb', glb()], ['outside.bin', new Uint8Array([1])], ['manifest.json', textBytes('{"formatVersion":1,"entryPath":"files/model.glb"}')]]), reason: 'resource namespace' },
  ])('refuses a registered package with $reason', ({ files }) => {
    expect(() => readRegisteredModelPackage(archive(files), IMPORT_LIMITS)).toThrow(Error);
  });

  it('reports an unknown manifest version for a valid package payload', () => {
    const original = glb();
    const bytes = archive(new Map([
      ['files/model.glb', original],
      ['manifest.json', textBytes(JSON.stringify({ formatVersion: 2, entryPath: 'files/model.glb' }))],
    ]));
    expect(() => readRegisteredModelPackage(bytes, IMPORT_LIMITS)).toThrow(/version/i);
  });
});

describe('model-package entry reading names its failures (inner#1690)', () => {
  it('reports glTF 1.0 as an unsupported version of the entry', () => {
    expect(() => readModelJson(textBytes(JSON.stringify({ asset: { version: '1.0' } })), 'old.gltf', IMPORT_LIMITS))
      .toThrow(expect.objectContaining({ code: 'unsupported', detail: 'glTF 1.0' }));
  });

  it('reports a binary glTF of container version 1 as unsupported', () => {
    const bytes = glb();
    new DataView(bytes.buffer).setUint32(4, 1, true);
    expect(() => readModelJson(bytes, 'old.glb', IMPORT_LIMITS)).toThrow(expect.objectContaining({ code: 'unsupported', detail: 'glTF 1' }));
  });

  it('names the entry whose JSON cannot be parsed', () => {
    expect(() => readModelJson(textBytes('{"asset":'), 'broken/scene.gltf', IMPORT_LIMITS))
      .toThrow(expect.objectContaining({ code: 'invalid', detail: 'broken/scene.gltf' }));
  });

  it('names a dependency URI whose percent escape is malformed', () => {
    expect(() => resolveModelDependency('scene.gltf', 'tex%E0%A4%A.png')).toThrow(expect.objectContaining({ code: 'invalid', detail: 'tex%E0%A4%A.png' }));
  });

  it('checks the declared sizes of an archive before inflating any entry', () => {
    const bytes = archive(new Map([['big.bin', new Uint8Array(1000)]]), 6);
    const header = new DataView(bytes.buffer);
    bytes[30 + header.getUint16(26, true) + header.getUint16(28, true)] = 0xff;
    expect(() => unpackModelArchive(bytes, { ...IMPORT_LIMITS, maxExpandedBytes: 999 })).toThrow(expect.objectContaining({ code: 'budget' }));
  });
});
