// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8 } from 'three/addons/libs/fflate.module.js';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { loadedResources } from '@web/spaces/three-d/model-loaded-resources';
import { resolveModelDependency } from '@web/spaces/three-d/model-package';
import type { GltfDocument, ModelPackage } from '@web/spaces/three-d/model-package';
import { createModelDecoder } from '@web/spaces/three-d/viewport/model-decoder-173';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));

/** Original files that remember every path the loader asks for. */
class RecordingFiles extends Map<string, Uint8Array<ArrayBuffer>> {
  readonly requested = new Set<string>();

  /**
   * Record a lookup by path.
   * @param path - A resolved resource path.
   * @returns The stored bytes.
   * @throws {never} Never.
   */
  override get(path: string): Uint8Array<ArrayBuffer> | undefined {
    this.requested.add(path);
    return super.get(path);
  }
}

/**
 * Build one model that exercises every resource path the r173 loader walks or skips, each accessor and image in its own file.
 * @returns The document and its files.
 * @throws {never} Never.
 */
function everyPath(): { json: GltfDocument; files: RecordingFiles } {
  const files = new RecordingFiles();
  const buffers: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  /**
   * Store values in a new file and return the accessor reading them.
   * @throws {never} Never.
   */
  const accessor = (name: string, type: string, values: Float32Array | Uint8Array, extra: Record<string, unknown> = {}): number => {
    const bytes = Uint8Array.from(new Uint8Array(values.buffer));
    files.set(`${name}.bin`, bytes);
    buffers.push({ uri: `${name}.bin`, byteLength: bytes.byteLength });
    bufferViews.push({ buffer: buffers.length - 1, byteLength: bytes.byteLength });
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    accessors.push({ bufferView: bufferViews.length - 1, type, componentType: values instanceof Float32Array ? 5126 : 5121, count: values.length / size, ...extra });
    return accessors.length - 1;
  };
  const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  /** @throws {never} Never. */
  const position = (name: string): number => accessor(name, 'VEC3', triangle, { min: [0, 0, 0], max: [1, 1, 0] });
  const images = ['base', 'unlitNormal', 'unused', 'clearcoat', 'extras'].map((name) => {
    files.set(`${name}.png`, PNG);
    return { uri: `${name}.png` };
  });
  const instances = accessor('instances', 'VEC3', new Float32Array(3));
  const pointInstances = accessor('pointInstances', 'VEC3', new Float32Array(3));
  const meshlessInstances = accessor('meshlessInstances', 'VEC3', new Float32Array(3));
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_materials_unlit', 'KHR_materials_clearcoat', 'EXT_mesh_gpu_instancing'],
    scene: 0,
    scenes: [{ nodes: [0, 6, 7] }],
    nodes: [
      { children: [1] },
      { mesh: 0, skin: 0 },
      { mesh: 1, children: [3] },
      { mesh: 2 },
      { mesh: 3 },
      { mesh: 4, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: instances } } } },
      { mesh: 5, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: pointInstances } } } },
      { extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: meshlessInstances } } } },
    ],
    meshes: [
      { weights: [0], primitives: [{ material: 0, attributes: { POSITION: position('skinned'), JOINTS_0: accessor('joints', 'VEC4', new Uint8Array(12)),
        WEIGHTS_0: accessor('weights', 'VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])) },
      targets: [{ POSITION: position('morphPosition'), TANGENT: accessor('morphTangent', 'VEC3', triangle) }] }] },
      { primitives: [{ attributes: { POSITION: position('joint') } }] },
      { primitives: [{ attributes: { POSITION: position('jointChild') } }] },
      { primitives: [{ attributes: { POSITION: position('orphan') } }] },
      { primitives: [{ material: 2, attributes: { POSITION: position('animated') } }] },
      { primitives: [{ mode: 0, attributes: { POSITION: position('points') } }] },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 }, extensions: { KHR_materials_unlit: {} } },
      { pbrMetallicRoughness: { baseColorTexture: { index: 2 } } },
      { extras: { lightTexture: { index: 4 } }, extensions: { KHR_materials_clearcoat: { clearcoatTexture: { index: 3 }, vendorData: { bakedTexture: { index: 4 } } } } },
    ],
    textures: images.map((_, source) => ({ source })),
    images,
    skins: [{ joints: [2], inverseBindMatrices: accessor('inverseBind', 'MAT4', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) }],
    animations: [{
      channels: [{ sampler: 0, target: { node: 5, path: 'translation' } }, { sampler: 1, target: { path: 'pointer' } }],
      samplers: [
        { input: accessor('animationInput', 'SCALAR', new Float32Array([0]), { min: [0], max: [0] }), output: accessor('animationOutput', 'VEC3', new Float32Array(3)) },
        { input: accessor('pointerInput', 'SCALAR', new Float32Array([0]), { min: [0], max: [0] }), output: accessor('pointerOutput', 'VEC3', new Float32Array(3)) },
      ],
    }],
    buffers, bufferViews, accessors,
  };
  files.set('model.gltf', Uint8Array.from(strToU8(JSON.stringify(json))));
  return { json: json as unknown as GltfDocument, files };
}

describe('loadedResources matches what the installed GLTFLoader requests (inner#1690)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names exactly the files the loader reads for a model using every walked and skipped path', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })));
    const blobs = new Map<string, Blob>();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => { const url = `blob:resource-${blobs.size}`; blobs.set(url, blob); return url; });
      static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(await blobs.get(input instanceof Request ? input.url : String(input))?.arrayBuffer())));
    const { json, files } = everyPath();
    const model: ModelPackage = { entry: 'model.gltf', files, json };
    const decoder = createModelDecoder(model, IMPORT_LIMITS);
    try {
      await decoder.loader.parseAsync(new TextDecoder().decode(files.get('model.gltf')), '');
    } finally {
      decoder.dispose();
    }
    const resources = loadedResources(json);
    const derived = [...[...resources.buffers].map((index) => json.buffers![index].uri!), ...[...resources.images].map((index) => json.images![index].uri!)]
      .map((uri) => resolveModelDependency('model.gltf', uri));
    files.requested.delete('model.gltf');
    expect(new Set(derived)).toEqual(files.requested);
    expect([...files.requested].sort()).toEqual(['animated.bin', 'animationInput.bin', 'animationOutput.bin', 'base.png', 'clearcoat.png',
      'instances.bin', 'inverseBind.bin', 'joint.bin', 'joints.bin', 'morphPosition.bin', 'points.bin', 'skinned.bin', 'weights.bin']);
  });
});
