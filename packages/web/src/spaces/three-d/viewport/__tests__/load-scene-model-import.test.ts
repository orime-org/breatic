// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { BufferGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';
import { httpRequest } from '@breatic/shared';
import type { SceneImportLimits } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import { disposeModelTemplate, loadSceneModel, parseSceneModel } from '@web/spaces/three-d/viewport/model-resources';
import { inspectModelFiles, readRegisteredModelPackage } from '@web/spaces/three-d/model-package';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { createModelDecoder, validateModelTextures } from '@web/spaces/three-d/viewport/model-decoder-173';

vi.mock('@breatic/shared', async (importOriginal) => ({
  ...await importOriginal<typeof SharedModule>(),
  httpRequest: vi.fn(),
}));

const templates = new Set<Group>();
const TRIANGLE = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const ASSET_URL = 'https://assets.example/registered-model';


/**
 * Describe a real mesh, hierarchy and original PBR material for the installed loader.
 * @throws {never} Never.
 */
function triangleJson(rootName: string, bufferUri?: string): Record<string, unknown> {
  return {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: rootName, translation: [0, 1, 0], children: [1] }, { name: 'Surface', mesh: 0 }],
    buffers: [{ byteLength: TRIANGLE.byteLength, ...(bufferUri !== undefined && { uri: bufferUri }) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: TRIANGLE.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'OriginalMaterial', pbrMetallicRoughness: {
      baseColorFactor: [0.25, 0.5, 0.75, 1], metallicFactor: 0.2, roughnessFactor: 0.65,
    } }],
  };
}

/**
 * Preserve binary geometry in a valid glTF 2.0 JSON/BIN container.
 * @throws {never} Never.
 */
function triangleGlb(rootName: string, requiredExtension?: string, image?: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const document = triangleJson(rootName);
  const binary = new Uint8Array(TRIANGLE.byteLength + (image ? Math.ceil(image.byteLength / 4) * 4 : 0));
  binary.set(new Uint8Array(TRIANGLE.buffer));
  if (image) {
    binary.set(image, TRIANGLE.byteLength);
    document.buffers = [{ byteLength: binary.byteLength }];
    document.bufferViews = [{ buffer: 0, byteLength: TRIANGLE.byteLength }, { buffer: 0, byteOffset: TRIANGLE.byteLength, byteLength: image.byteLength }];
    document.images = [{ bufferView: 1, mimeType: 'image/png' }];
    document.textures = [{ source: 0 }];
    document.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  }
  if (requiredExtension !== undefined) {
    document.extensionsUsed = [requiredExtension];
    document.extensionsRequired = [requiredExtension];
  }
  const json = strToU8(JSON.stringify(document));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const result = new Uint8Array(12 + 8 + jsonLength + 8 + binary.byteLength);
  const header = new DataView(result.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  result.fill(0x20, 20, 20 + jsonLength);
  result.set(json, 20);
  header.setUint32(20 + jsonLength, binary.byteLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  result.set(binary, 28 + jsonLength);
  return result;
}

/**
 * Encode the confirmed model-package manifest around unmodified source files.
 * @throws {Error} When the ZIP encoder rejects the fixture.
 */
function modelPackage(entryPath: string, files: Record<string, Uint8Array>, formatVersion = 1): ArrayBuffer {
  return Uint8Array.from(zipSync({
    ...Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Uint8Array.from(bytes)])),
    'manifest.json': Uint8Array.from(strToU8(JSON.stringify({ formatVersion, entryPath }))),
  }, { level: 0 })).buffer;
}

/**
 * Isolate the asset HTTP request while retaining the real model decoder.
 * @throws {Error} When the production model loader rejects the input.
 */
function loadRegistered(bytes: ArrayBuffer, mimeType: string, sizeBytes = bytes.byteLength, limits: SceneImportLimits = IMPORT_LIMITS): Promise<Group> {
  vi.mocked(httpRequest).mockResolvedValue(new Response(bytes));
  const resolve = vi.fn(async () => ({ url: ASSET_URL, mimeType, sizeBytes }));
  // jsdom has no Worker; the registered package is read with the same function the worker runs.
  const readPackage = async (packageBytes: Uint8Array<ArrayBuffer>): Promise<ModelPackage> => readRegisteredModelPackage(packageBytes, limits);
  return loadSceneModel({ kind: 'asset', assetId: 'registered-model' }, new AbortController().signal, resolve, '#888888', limits, undefined, readPackage)
    .then((root) => { templates.add(root); return root; });
}

/**
 * Assert the geometry, source hierarchy and original material survived decoding.
 * @throws {Error} When an assertion fails.
 */
function expectTriangle(root: Group, rootName: string): void {
  expect(root.children.map((child) => child.name)).toEqual([rootName]);
  expect(root.children[0]?.position.toArray()).toEqual([0, 1, 0]);
  const meshes: Mesh[] = [];
  root.traverse((child) => { if (child instanceof Mesh) meshes.push(child); });
  expect(meshes.map((mesh) => mesh.name)).toEqual(['Surface']);
  expect(Array.from(meshes[0].geometry.getAttribute('position').array)).toEqual(Array.from(TRIANGLE));
  expect(meshes[0].material).toMatchObject({ name: 'OriginalMaterial', metalness: 0.2, roughness: 0.65,
    color: { r: 0.25, g: 0.5, b: 0.75 } });
}

describe('registered model import containers (inner#1690)', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => {
    for (const root of templates) disposeModelTemplate(root);
    templates.clear();
  });

  it('retains geometry, hierarchy and original material in an independent GLB', async () => {
    const root = await loadRegistered(triangleGlb('CharacterRoot').buffer, 'model/gltf-binary');
    expectTriangle(root, 'CharacterRoot');
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('retains a GLB embedded texture resolved through the loader-owned blob URL', async () => {
    const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));
    const bitmap = vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }));
    const request = vi.fn(async () => new Response(image));
    vi.stubGlobal('createImageBitmap', bitmap);
    vi.stubGlobal('fetch', request);
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:model-image');
      static revokeObjectURL = vi.fn();
    });
    const root = await loadRegistered(triangleGlb('TexturedRoot', undefined, image).buffer, 'model/gltf-binary');
    const mesh = root.getObjectByName('Surface');

    expect(mesh).toBeInstanceOf(Mesh);
    if (!(mesh instanceof Mesh) || Array.isArray(mesh.material)) throw new Error('Expected one textured mesh material');
    expect(mesh.material).toMatchObject({ map: { image: { width: 1, height: 1 } } });
    expect(bitmap).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['blob:foreign-model-image', 'https://external.example/texture.png'])('rejects a declared image URI outside the closed collection: %s', async (uri) => {
    const geometry = btoa(String.fromCharCode(...new Uint8Array(TRIANGLE.buffer)));
    const bytes = modelPackage('files/model.gltf', {
      'files/model.gltf': strToU8(JSON.stringify({
        ...triangleJson('CharacterRoot', `data:application/octet-stream;base64,${geometry}`), images: [{ uri }],
      })),
    });
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(loadRegistered(bytes, 'application/zip')).rejects.toThrow('must be provided locally');
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the manifest entry regardless of the order of other valid models in the ZIP', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (reverse) => {
      const files = [
        ['files/character/model.glb', triangleGlb('CharacterRoot')],
        ['files/other/model.glb', triangleGlb('OtherRoot')],
      ] as const;
      const bytes = modelPackage('files/character/model.glb', Object.fromEntries(reverse ? [...files].reverse() : files));
      const root = await loadRegistered(bytes, 'application/zip');
      expectTriangle(root, 'CharacterRoot');
      disposeModelTemplate(root);
      templates.delete(root);
    }));
  });

  it('reads a glTF entry and its embedded geometry from a registered model package', async () => {
    const geometry = btoa(String.fromCharCode(...new Uint8Array(TRIANGLE.buffer)));
    const bytes = modelPackage('files/character/scene.gltf', {
      'files/character/scene.gltf': strToU8(JSON.stringify(triangleJson('CharacterRoot', `data:application/octet-stream;base64,${geometry}`))),
    });
    const root = await loadRegistered(bytes, 'application/zip');
    expectTriangle(root, 'CharacterRoot');
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });

  it('identifies the missing package dependency before any external resource is requested', async () => {
    const externalRequest = vi.fn().mockRejectedValue(new Error('Unexpected external model request'));
    vi.stubGlobal('fetch', externalRequest);
    const bytes = modelPackage('files/character/scene.gltf', {
      'files/character/scene.gltf': strToU8(JSON.stringify(triangleJson('CharacterRoot', 'geometry.bin'))),
    });
    await expect(loadRegistered(bytes, 'application/zip')).rejects.toThrow('geometry.bin');
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(externalRequest).toHaveBeenCalledTimes(0);
  });

  it('reports an unsupported model-package version', async () => {
    const bytes = modelPackage('files/character/model.glb', {
      'files/character/model.glb': triangleGlb('CharacterRoot'),
    }, 2);
    await expect(loadRegistered(bytes, 'application/zip')).rejects.toThrow(/version/i);
  });

  it('rejects an entry path outside the model-package file namespace', async () => {
    const bytes = modelPackage('../model.glb', { '../model.glb': triangleGlb('CharacterRoot') });
    await expect(loadRegistered(bytes, 'application/zip')).rejects.toThrow(/entry|path|manifest/i);
  });

  it('reports an unknown required extension before accepting its otherwise valid GLB', async () => {
    const bytes = triangleGlb('CharacterRoot', 'VENDOR_unknown_required');
    await expect(loadRegistered(bytes.buffer, 'model/gltf-binary')).rejects.toThrow('VENDOR_unknown_required');
  });

  it('rejects an oversized registered asset before downloading its bytes', async () => {
    const loading = loadRegistered(triangleGlb('CharacterRoot').buffer, 'model/gltf-binary', 268435457);
    await expect(loading).rejects.toBeInstanceOf(Error);
    expect(httpRequest).toHaveBeenCalledTimes(0);
  });

  it('uses a lower configured artifact budget to reject registered bytes before transfer', async () => {
    const bytes = triangleGlb('CharacterRoot');
    const limits = { ...IMPORT_LIMITS, maxArtifactBytes: bytes.byteLength - 1 };
    const loading = loadRegistered(bytes.buffer, 'model/gltf-binary', bytes.byteLength, limits);

    await expect(loading).rejects.toBeInstanceOf(Error);
    expect(httpRequest).toHaveBeenCalledTimes(0);
  });

  it.each(['preview', 'registered'] as const)('checks image metadata before accepting a %s model', async (entryPoint) => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));
    new DataView(png.buffer).setUint32(16, IMPORT_LIMITS.maxTextureEdge + 1);
    const geometry = btoa(String.fromCharCode(...new Uint8Array(TRIANGLE.buffer)));
    const json = Uint8Array.from(strToU8(JSON.stringify({
      ...triangleJson('CharacterRoot', `data:application/octet-stream;base64,${geometry}`),
      images: [{ uri: `data:image/png;base64,${btoa(String.fromCharCode(...png))}` }],
    })));
    const loading = entryPoint === 'registered'
      ? loadRegistered(modelPackage('files/scene.gltf', { 'files/scene.gltf': json }), 'application/zip')
      : parseSceneModel(inspectModelFiles(new Map([['scene.gltf', json]]), 'scene.gltf', IMPORT_LIMITS), new AbortController().signal, IMPORT_LIMITS)
        .then((root) => { templates.add(root); return root; });

    await expect(loading).rejects.toThrow(/texture.*dimension/i);
  });

  it('loads the same registered size when it fits the configured artifact budget', async () => {
    const bytes = triangleGlb('CharacterRoot');
    const limits = { ...IMPORT_LIMITS, maxArtifactBytes: bytes.byteLength };
    const root = await loadRegistered(bytes.buffer, 'model/gltf-binary', bytes.byteLength, limits);

    expectTriangle(root, 'CharacterRoot');
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });
});

describe('decoded texture budgets (inner#1690)', () => {
  it('refuses textures over the cumulative budget as an import limit', () => {
    const scene = new Group();
    for (const _ of [0, 1]) {
      const map = new Texture();
      map.image = { width: 64, height: 64 };
      map.generateMipmaps = false;
      scene.add(new Mesh(new BufferGeometry(), new MeshBasicMaterial({ map })));
    }
    expect(() => validateModelTextures([scene], { ...IMPORT_LIMITS, maxTextureBytes: 64 * 64 * 4 * 2 })).not.toThrow();
    expect(() => validateModelTextures([scene], { ...IMPORT_LIMITS, maxTextureBytes: 64 * 64 * 4 * 2 - 1 })).toThrow(expect.objectContaining({ code: 'budget' }));
  });
});

describe('line and point primitive release (inner#1690)', () => {
  it('releases line geometry and material with the template', async () => {
    const geometry = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...geometry))}`;
    const json = Uint8Array.from(strToU8(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 1 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] }],
      buffers: [{ byteLength: geometry.byteLength, uri }], bufferViews: [{ buffer: 0, byteLength: geometry.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] }] })));
    const root = await parseSceneModel(inspectModelFiles(new Map([['lines.gltf', json]]), 'lines.gltf', IMPORT_LIMITS), new AbortController().signal, IMPORT_LIMITS);
    const released: string[] = [];
    root.traverse((child) => {
      if (!('geometry' in child && 'material' in child)) return;
      const owner = child as unknown as { type: string; geometry: BufferGeometry; material: MeshBasicMaterial };
      owner.geometry.addEventListener('dispose', () => released.push(`${owner.type}:geometry`));
      owner.material.addEventListener('dispose', () => released.push(`${owner.type}:material`));
    });
    disposeModelTemplate(root);
    expect(released.sort()).toEqual(['LineSegments:geometry', 'LineSegments:material', 'Mesh:geometry', 'Mesh:material']);
  });
});

describe('decoder failures name model resources (inner#1690)', () => {
  it('reports a failed resource by its model path, not the object URL it was loaded from', () => {
    const json = Uint8Array.from(strToU8(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'textures/albedo.png' }] })));
    const model = inspectModelFiles(new Map([['models/scene.gltf', json], ['models/textures/albedo.png', new Uint8Array([1, 2, 3])]]), 'models/scene.gltf', IMPORT_LIMITS);
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:model/1'), revokeObjectURL: vi.fn() }));
    const decoder = createModelDecoder(model, IMPORT_LIMITS);
    const objectUrl = decoder.loader.manager.resolveURL('textures/albedo.png');
    expect(objectUrl).toBe('blob:model/1');
    decoder.loader.manager.itemError(objectUrl);
    expect(decoder.failedResources).toEqual(['models/textures/albedo.png']);
    decoder.dispose();
  });

  it('states the full decoded texture size against its limit', () => {
    const scene = new Group();
    for (const _ of [0, 1, 2]) {
      const map = new Texture();
      map.image = { width: 64, height: 64 };
      map.generateMipmaps = false;
      scene.add(new Mesh(new BufferGeometry(), new MeshBasicMaterial({ map })));
    }
    expect(() => validateModelTextures([scene], { ...IMPORT_LIMITS, maxTextureBytes: 64 * 64 * 4 })).toThrow(expect.objectContaining({
      code: 'budget', budget: { limit: 'textureBytes', allowed: 64 * 64 * 4, actual: 64 * 64 * 4 * 3 },
    }));
  });
});
