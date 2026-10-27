// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Mesh } from 'three';
import type { Group } from 'three';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';
import { httpRequest } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import { disposeModelTemplate, loadSceneModel } from '@web/spaces/three-d/viewport/model-resources';

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
function triangleGlb(rootName: string, requiredExtension?: string): Uint8Array<ArrayBuffer> {
  const document = triangleJson(rootName);
  if (requiredExtension !== undefined) {
    document.extensionsUsed = [requiredExtension];
    document.extensionsRequired = [requiredExtension];
  }
  const json = strToU8(JSON.stringify(document));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const binary = new Uint8Array(TRIANGLE.buffer);
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
    ...files,
    'manifest.json': strToU8(JSON.stringify({ formatVersion, entryPath })),
  }, { level: 0 })).buffer;
}

/**
 * Isolate the asset HTTP request while retaining the real model decoder.
 * @throws {Error} When the production model loader rejects the input.
 */
function loadRegistered(bytes: ArrayBuffer, mimeType: string, sizeBytes = bytes.byteLength): Promise<Group> {
  vi.mocked(httpRequest).mockResolvedValue(new Response(bytes));
  const resolve = vi.fn(async () => ({ url: ASSET_URL, mimeType, sizeBytes }));
  return loadSceneModel({ kind: 'asset', assetId: 'registered-model' }, new AbortController().signal, resolve, '#888888')
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
});
