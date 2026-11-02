// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { BufferGeometry, Group, Mesh, MeshBasicMaterial, Texture } from 'three';
import type { WebGLRenderer } from 'three';
import { IMPORT_LIMITS, TEXTURE_FORMATS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';
import { httpRequest } from '@breatic/shared';
import type { SceneImportLimits } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import { disposeModelTemplate, loadSceneModel, parseSceneModel } from '@web/spaces/three-d/viewport/model-resources';
import { inspectModelFiles, readRegisteredModelPackage } from '@web/spaces/three-d/model-package';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { readRegisteredModelPackageInWorker } from '@web/spaces/three-d/model-import-worker-client';
import { validateModelTextures } from '@web/spaces/three-d/viewport/model-decoder-173';
import { validateModelTextureMetadata } from '@web/spaces/three-d/model-texture-metadata';

// jsdom has no Worker; the mocked client runs the same package reader the worker runs.
vi.mock('@web/spaces/three-d/model-import-worker-client', async () => {
  const { readRegisteredModelPackage: read } = await vi.importActual<typeof import('@web/spaces/three-d/model-package')>('@web/spaces/three-d/model-package');
  return { readRegisteredModelPackageInWorker: vi.fn(async (bytes: Uint8Array<ArrayBuffer>, _signal: AbortSignal, limits: SceneImportLimits) => read(bytes, limits, { webp: true, avif: true })) };
});

// jsdom never decodes the format probe images; the browser under test decodes WebP and AVIF.
vi.mock('@web/spaces/three-d/model-texture-format', () => ({ detectTextureFormatSupport: vi.fn(async () => ({ webp: true, avif: true })) }));


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
  return loadSceneModel({ kind: 'asset', assetId: 'registered-model' }, new AbortController().signal, resolve, '#888888', limits)
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
    await expect(loadRegistered(bytes.buffer, 'model/gltf-binary')).rejects.toMatchObject({ code: 'unsupported', detail: 'VENDOR_unknown_required' });
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
      images: [{ uri: `data:image/png;base64,${btoa(String.fromCharCode(...png))}` }], textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    })));
    const loading = entryPoint === 'registered'
      ? loadRegistered(modelPackage('files/scene.gltf', { 'files/scene.gltf': json }), 'application/zip')
      : parseSceneModel(inspectModelFiles(new Map([['scene.gltf', json]]), 'scene.gltf', IMPORT_LIMITS, TEXTURE_FORMATS), new AbortController().signal, IMPORT_LIMITS)
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
    const root = await parseSceneModel(inspectModelFiles(new Map([['lines.gltf', json]]), 'lines.gltf', IMPORT_LIMITS, TEXTURE_FORMATS), new AbortController().signal, IMPORT_LIMITS);
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
  it('names an embedded image that fails to decode, and refuses the model', async () => {
    const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed'); }));
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:model-image');
      static revokeObjectURL = vi.fn();
    });
    await expect(loadRegistered(triangleGlb('BrokenTexture', undefined, image).buffer, 'model/gltf-binary'))
      .rejects.toMatchObject({ code: 'invalid', detail: 'images[0]' });
  });

  it('unpacks a registered package through the worker client with the lease signal', async () => {
    const bytes = modelPackage('files/model.glb', { 'files/model.glb': triangleGlb('Packaged') });
    await loadRegistered(bytes, 'application/zip');
    expect(readRegisteredModelPackageInWorker).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(AbortSignal), IMPORT_LIMITS);
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

describe('checks follow the resources GLTFLoader loads (inner#1690)', () => {
  const geometry = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const embedded = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...geometry))}`;
  /**
   * Build a triangle glTF with extra declarations, parsed from its own collection.
   * @throws {Error} When the fixture cannot be parsed.
   */
  function triangle(extra: Record<string, unknown>, files: [string, Uint8Array<ArrayBuffer>][] = [], buffer: Record<string, unknown> = { byteLength: geometry.byteLength, uri: embedded }): ReturnType<typeof inspectModelFiles> {
    const json = Uint8Array.from(strToU8(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [buffer],
      bufferViews: [{ buffer: 0, byteLength: geometry.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] }], ...extra })));
    return inspectModelFiles(new Map([['scene.gltf', json], ...files]), 'scene.gltf', IMPORT_LIMITS, TEXTURE_FORMATS);
  }

  it.each([[8192, true], [16, false]])('holds the texture bytes another browser decodes (an AVIF of %i px) to the cumulative budget', async (edge, refused) => {
    const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));
    const png = (size: number): Uint8Array<ArrayBuffer> => {
      const bytes = Uint8Array.from(PNG);
      new DataView(bytes.buffer).setUint32(16, size);
      new DataView(bytes.buffer).setUint32(20, size);
      return bytes;
    };
    const files = new Map<string, Uint8Array<ArrayBuffer>>([['color.png', png(16)], ['color.avif', png(edge)]]);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 16, close: vi.fn() })));
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => `blob:${(blob as File).name ?? 'image'}`);
      static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png(16))));
    vi.stubGlobal('Image', class {
      height = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      /** Decode GLTFLoader's AVIF probe image as a browser without AVIF support does. */
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    const model = triangle({
      extensionsUsed: ['EXT_texture_avif'],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0, extensions: { EXT_texture_avif: { source: 1 } } }],
      images: [{ uri: 'color.png' }, { uri: 'color.avif' }],
    }, [...files]);
    const parsed = parseSceneModel({ ...model, support: { webp: true, avif: false } }, new AbortController().signal, IMPORT_LIMITS);
    if (refused) await expect(parsed).rejects.toThrow(expect.objectContaining({ code: 'budget', budget: expect.objectContaining({ limit: 'textureBytes' }) }));
    else disposeModelTemplate(await parsed);
  });

  it('loads a model whose unused texture has no source', async () => {
    const root = await parseSceneModel(triangle({ textures: [{ sampler: 0 }], samplers: [{}] }), new AbortController().signal, IMPORT_LIMITS);
    templates.add(root);
    expect(root.getObjectByProperty('type', 'Mesh')).toBeDefined();
  });

  it.each([['no source', {}], ['a missing image', { source: 7 }]])('names a texture a material uses when it has %s', (_label, texture) => {
    expect(() => triangle({ textures: [texture], images: [{ uri: 'unused.png' }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }] }, [['unused.png', geometry]]))
      .toThrow(expect.objectContaining({ code: 'invalid', detail: 'textures[0]' }));
  });

  it('leaves out an image only an unsupported optional extension uses', () => {
    const model = triangle({ extensionsUsed: ['MSFT_texture_dds'], images: [{ uri: 'tex.dds' }] }, [['tex.dds', new Uint8Array([0x44, 0x44, 0x53, 0x20])]]);
    expect(() => validateModelTextureMetadata(model, IMPORT_LIMITS)).not.toThrow();
  });

  it('names a geometry buffer shorter than its declared length', () => {
    expect(() => triangle({}, [['mesh.bin', geometry.slice(0, 12)]], { byteLength: geometry.byteLength, uri: 'mesh.bin' }))
      .toThrow(expect.objectContaining({ code: 'invalid', detail: 'mesh.bin' }));
  });
});

describe('meshopt fallback buffers (inner#1690)', () => {
  it('previews the shipped EXT_meshopt fixture, whose fallback buffer has no data', async () => {
    const json = Uint8Array.from(readFileSync('tests/fixtures/three-d-model-import/meshopt.gltf'));
    expect(() => inspectModelFiles(new Map([['meshopt.gltf', json]]), 'meshopt.gltf', IMPORT_LIMITS, TEXTURE_FORMATS)).not.toThrow();
  });
});

describe('declared buffer lengths are measured on the bytes the loader reads (inner#1690)', () => {
  const triangleBytes = new Uint8Array(TRIANGLE.buffer);
  /**
   * Inspect a triangle whose second buffer feeds a byte attribute.
   * @throws {ModelImportError} When inspection refuses the model.
   */
  function withSecondBuffer(buffer: Record<string, unknown>, files: [string, Uint8Array<ArrayBuffer>][] = []): unknown {
    const json = Uint8Array.from(strToU8(JSON.stringify({ ...triangleJson('Root', `data:application/octet-stream;base64,${btoa(String.fromCharCode(...triangleBytes))}`),
      buffers: [{ byteLength: TRIANGLE.byteLength, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...triangleBytes))}` }, buffer],
      bufferViews: [{ buffer: 0, byteLength: TRIANGLE.byteLength }, { buffer: 1, byteLength: 4 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5121, count: 4, type: 'SCALAR' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, _ID: 1 }, material: 0 }] }] })));
    return inspectModelFiles(new Map([['scene.gltf', json], ...files]), 'scene.gltf', IMPORT_LIMITS, TEXTURE_FORMATS);
  }

  it('counts percent-encoded data URI bytes, not characters', () => {
    expect(() => withSecondBuffer({ uri: 'data:application/octet-stream,%C3%A9%C3%A9', byteLength: 4 })).not.toThrow();
    expect(() => withSecondBuffer({ uri: 'data:application/octet-stream,%C3%A9%C3', byteLength: 4 }))
      .toThrow(expect.objectContaining({ code: 'invalid', detail: 'buffers[1]' }));
  });

  it('names a base64 data URI buffer shorter than declared', () => {
    expect(() => withSecondBuffer({ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 4 }))
      .toThrow(expect.objectContaining({ code: 'invalid', detail: 'buffers[1]' }));
  });

  it('names a buffer after the first that has no URI, in a glTF and in a GLB', () => {
    expect(() => withSecondBuffer({ byteLength: 4 })).toThrow(expect.objectContaining({ code: 'invalid', detail: 'buffers[1]' }));
    const json = strToU8(JSON.stringify({ ...triangleJson('Root'), buffers: [{ byteLength: TRIANGLE.byteLength }, { byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteLength: TRIANGLE.byteLength }, { buffer: 1, byteLength: 4 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5121, count: 4, type: 'SCALAR' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, _ID: 1 }, material: 0 }] }] }));
    const jsonLength = Math.ceil(json.byteLength / 4) * 4;
    const glb = new Uint8Array(28 + jsonLength + TRIANGLE.byteLength);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.byteLength, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.fill(0x20, 20, 20 + jsonLength);
    glb.set(json, 20);
    view.setUint32(20 + jsonLength, TRIANGLE.byteLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    glb.set(triangleBytes, 28 + jsonLength);
    expect(() => inspectModelFiles(new Map([['scene.glb', glb]]), 'scene.glb', IMPORT_LIMITS, TEXTURE_FORMATS))
      .toThrow(expect.objectContaining({ code: 'invalid', detail: 'buffers[1]' }));
  });

  it('names a GLB whose binary chunk is shorter than its buffer', () => {
    const glb = triangleGlb('Root');
    const view = new DataView(glb.buffer);
    const jsonLength = view.getUint32(12, true);
    view.setUint32(20 + jsonLength, TRIANGLE.byteLength - 4, true);
    expect(() => inspectModelFiles(new Map([['scene.glb', glb.slice(0, glb.byteLength - 4)]]), 'scene.glb', IMPORT_LIMITS, TEXTURE_FORMATS))
      .toThrow(expect.objectContaining({ code: 'invalid', detail: 'scene.glb' }));
  });
});

describe('decoder downloads are not model content (inner#1690)', () => {
  const directory = 'tests/fixtures/three-d-model-import';
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    ['Draco', 'draco.gltf', [] as string[], false],
    ['KTX2', 'ktx2.gltf', ['normal.ktx2'], false],
    ['KTX2 the model does not declare', 'ktx2.gltf', ['normal.ktx2'], true],
  ])('keeps a failed %s decoder download a plain, retryable error', async (_label, entry, extra, undeclared) => {
    vi.stubGlobal('Request', class { constructor(readonly url: string) {} });
    const fetched = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetched);
    const files = new Map([entry, ...extra].map((path) => [path, Uint8Array.from(readFileSync(`${directory}/${path}`))] as const));
    if (undeclared) {
      // GLTFLoader decodes a basisu texture even when extensionsUsed does not list the extension.
      const json = JSON.parse(new TextDecoder().decode(files.get(entry))) as Record<string, unknown>;
      delete json.extensionsUsed;
      delete json.extensionsRequired;
      files.set(entry, Uint8Array.from(strToU8(JSON.stringify(json))));
    }
    const model = inspectModelFiles(files, entry, IMPORT_LIMITS, TEXTURE_FORMATS);
    const renderer = { extensions: { has: () => false }, capabilities: { maxTextureSize: 4096 } } as unknown as WebGLRenderer;
    const failure = await parseSceneModel(model, new AbortController().signal, IMPORT_LIMITS, renderer).then(() => undefined, (error: unknown) => error);
    expect(fetched).toHaveBeenCalled();
    expect(failure).toMatchObject({ name: 'TypeError', message: 'Failed to fetch' });
    expect(failure).not.toBeInstanceOf(ModelImportError);
  });
});

describe('content found after parsing is a content verdict (inner#1690)', () => {
  const embedded = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...new Uint8Array(TRIANGLE.buffer)))}`;
  it.each([
    ['no scenes', (json: Record<string, unknown>) => { delete json.scenes; delete json.scene; }],
    ['a default scene past its scenes', (json: Record<string, unknown>) => { json.scene = 3; }],
  ])('refuses a model with %s as having nothing to display', async (_label, edit) => {
    const json = triangleJson('Root', embedded);
    edit(json);
    const model = inspectModelFiles(new Map([['scene.gltf', Uint8Array.from(strToU8(JSON.stringify(json)))]]), 'scene.gltf', IMPORT_LIMITS, TEXTURE_FORMATS);
    await expect(parseSceneModel(model, new AbortController().signal, IMPORT_LIMITS)).rejects.toMatchObject({ name: 'ModelImportError', code: 'empty' });
  });

  it('names a registered manifest that is not JSON', () => {
    const bytes = Uint8Array.from(zipSync({ 'files/m.gltf': Uint8Array.from(strToU8('{"asset":{"version":"2.0"}}')), 'manifest.json': Uint8Array.from(strToU8('{not json')) }, { level: 0 }));
    expect(() => readRegisteredModelPackage(bytes, IMPORT_LIMITS, TEXTURE_FORMATS)).toThrow(expect.objectContaining({ name: 'ModelImportError', code: 'invalid', detail: 'manifest.json' }));
  });

  it('names a decoded texture that is not a 2D image', () => {
    // KTX2Loader gives a cube texture its six faces as an array image.
    const texture = new Texture([{ width: 1, height: 1 }, { width: 1, height: 1 }] as unknown as HTMLImageElement);
    texture.name = 'sky.ktx2';
    const scene = new Group().add(new Mesh(new BufferGeometry(), new MeshBasicMaterial({ map: texture })));
    expect(() => validateModelTextures([scene], IMPORT_LIMITS)).toThrow(expect.objectContaining({ name: 'ModelImportError', code: 'invalid', detail: 'sky.ktx2' }));
  });
});

describe('cancelling while a decoder downloads (inner#1690)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    ['Draco', 'draco.gltf', [] as string[]],
    ['KTX2', 'ktx2.gltf', ['normal.ktx2']],
  ])('starts no %s decoder work afterwards and releases what the download created', async (_label, entry, extra) => {
    let release: () => void = () => undefined;
    const downloaded = new Promise<void>((resolve) => { release = resolve; });
    // The decoder asset URLs are root-relative under vitest, which the Node Request constructor rejects.
    vi.stubGlobal('Request', class { constructor(readonly url: string) {} });
    const fetched = vi.fn(async () => { await downloaded; return new Response(new Uint8Array(8)); });
    vi.stubGlobal('fetch', fetched);
    const revoked: string[] = [];
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:decoder-worker-source');
      static revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
    });
    const workers = vi.fn();
    vi.stubGlobal('Worker', class { constructor() { workers(); } postMessage(): void {} terminate(): void {} addEventListener(): void {} });
    const files = new Map([entry, ...extra].map((path) => [path, Uint8Array.from(readFileSync(`tests/fixtures/three-d-model-import/${path}`))] as const));
    const model = inspectModelFiles(files, entry, IMPORT_LIMITS, TEXTURE_FORMATS);
    const renderer = { extensions: { has: () => false }, capabilities: { maxTextureSize: 4096 } } as unknown as WebGLRenderer;
    const abort = new AbortController();
    const loading = parseSceneModel(model, abort.signal, IMPORT_LIMITS, renderer);
    abort.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(fetched).toHaveBeenCalled();
    await vi.waitFor(() => expect(revoked).toContain('blob:decoder-worker-source'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(workers).not.toHaveBeenCalled();
  });
});

describe('Draco declared but not used by a loaded primitive (inner#1690)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('loads without the Draco decoder, as GLTFLoader does', async () => {
    vi.stubGlobal('Request', class { constructor(readonly url: string) {} });
    // The embedded buffer still loads; only the decoder download fails.
    const fetched = vi.fn(async (input: { url: string }) => {
      if (!input.url.startsWith('data:')) throw new TypeError('Failed to fetch');
      return new Response(Uint8Array.from(atob(input.url.slice(input.url.indexOf(',') + 1)), (value) => value.charCodeAt(0)));
    });
    vi.stubGlobal('fetch', fetched);
    const json = { ...triangleJson('Root', `data:application/octet-stream;base64,${btoa(String.fromCharCode(...new Uint8Array(TRIANGLE.buffer)))}`), extensionsUsed: ['KHR_draco_mesh_compression'] };
    const model = inspectModelFiles(new Map([['scene.gltf', Uint8Array.from(strToU8(JSON.stringify(json)))]]), 'scene.gltf', IMPORT_LIMITS, TEXTURE_FORMATS);
    const root = await parseSceneModel(model, new AbortController().signal, IMPORT_LIMITS);
    templates.add(root);
    expect(root.getObjectByName('Surface')).toBeDefined();
  });
});
