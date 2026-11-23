// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { InstancedMesh, Mesh, SkinnedMesh, type Material } from 'three';
import { httpRequest } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { disposeModelTemplate, loadSceneModel, lookModelOf } from '@web/spaces/three-d/viewport/model-resources';
import { createPoseRig } from '@web/spaces/three-d/viewport/pose-rig';

// Tests run from packages/web; the bytes are the committed asset the browser fetches.
const FIGURE_PATH = 'src/spaces/three-d/viewport/assets/figure.glb';

vi.mock('@breatic/shared', async (importOriginal) => ({ ...await importOriginal<typeof SharedModule>(), httpRequest: vi.fn() }));
// jsdom never decodes the format probe images; the browser under test decodes WebP and AVIF.
vi.mock('@web/spaces/three-d/model-texture-format', () => ({ detectTextureFormatSupport: vi.fn(async () => ({ webp: true, avif: true })) }));

/** Encode the glTF 2 binary container around a real minimal scene.
 * @throws {never} Never.
 */
function glb(): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'registered-model' }] }));
  const padded = Math.ceil(json.byteLength / 4) * 4;
  const result = new ArrayBuffer(20 + padded);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, padded, true);
  header.setUint32(16, 0x4e4f534a, true);
  const payload = new Uint8Array(result, 20);
  payload.fill(0x20);
  payload.set(json);
  return result;
}

/**
 * A binary glTF with one mesh of two primitives (material 1, and none) and an instanced node of a mesh in material 0.
 * @returns The container.
 */
function partsGlb(): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], extensionsUsed: ['EXT_mesh_gpu_instancing'],
    nodes: [{ mesh: 0 }, { mesh: 1, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 1 }, { attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'a' }, { name: 'b' }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }],
    buffers: [{ byteLength: 60 }],
  }));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const bin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0]);
  const result = new ArrayBuffer(12 + 8 + jsonLength + 8 + bin.byteLength);
  const view = new DataView(result);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  const jsonChunk = new Uint8Array(result, 20, jsonLength); jsonChunk.fill(0x20); jsonChunk.set(json);
  view.setUint32(20 + jsonLength, bin.byteLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(result, 28 + jsonLength).set(new Uint8Array(bin.buffer));
  return result;
}

describe('registered GLB placement transport (inner#1689)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resolves an asset id, uses shared HTTP and parses with the installed GLTFLoader', async () => {
    vi.mocked(httpRequest).mockResolvedValue(new Response(glb()));
    const resolve = vi.fn().mockResolvedValue({ url: 'https://assets.example/model.glb', mimeType: 'model/gltf-binary', sizeBytes: glb().byteLength });
    const signal = new AbortController().signal;
    const root = await loadSceneModel({ kind: 'asset', assetId: 'registered' }, signal, resolve, '#888888', IMPORT_LIMITS);
    expect(resolve).toHaveBeenCalledWith('registered', signal);
    expect(httpRequest).toHaveBeenCalledWith('https://assets.example/model.glb', { method: 'GET' }, { replaySafe: true, signal });
    expect(root.children.map((child) => child.name)).toEqual(['registered-model']);
    disposeModelTemplate(root);
  });

  it('does not transfer an asset after its owner aborted while resolving', async () => {
    const abort = new AbortController();
    const resolve = vi.fn().mockImplementation(async () => {
      abort.abort();
      return { url: 'https://assets.example/model.glb', mimeType: 'model/gltf-binary', sizeBytes: glb().byteLength };
    });
    await expect(loadSceneModel({ kind: 'asset', assetId: 'registered' }, abort.signal, resolve, '#888888', IMPORT_LIMITS)).rejects.toMatchObject({ name: 'AbortError' });
    expect(httpRequest).toHaveBeenCalledTimes(0);
  });

  it('rejects unsupported types before transfer and malformed binary containers before parsing', async () => {
    const signal = new AbortController().signal;
    const resolve = vi.fn().mockResolvedValue({ url: 'https://assets.example/model.glb', mimeType: 'model/gltf+json', sizeBytes: glb().byteLength });
    await expect(loadSceneModel({ kind: 'asset', assetId: 'registered' }, signal, resolve, '#888888', IMPORT_LIMITS)).rejects.toThrow('unsupported model type');
    expect(httpRequest).toHaveBeenCalledTimes(0);
    resolve.mockResolvedValue({ url: 'https://assets.example/model.glb', mimeType: 'model/gltf-binary', sizeBytes: glb().byteLength });
    vi.mocked(httpRequest).mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    await expect(loadSceneModel({ kind: 'asset', assetId: 'registered' }, signal, resolve, '#888888', IMPORT_LIMITS)).rejects.toThrow('not a binary glTF');
  });

  // inner#1692 replaced the procedural nine-part figure with the rigged GLB asset; only the stage block stays procedural.
  it('builds the stage block procedurally without any transfer', async () => {
    const resolve = vi.fn();
    const root = await loadSceneModel({ kind: 'builtin', id: 'box' }, new AbortController().signal, resolve, '#888888', IMPORT_LIMITS);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toBeInstanceOf(Mesh);
    expect(resolve).toHaveBeenCalledTimes(0);
    expect(httpRequest).toHaveBeenCalledTimes(0);
    disposeModelTemplate(root);
  });

  it('loads the built-in figure from its same-origin GLB as a rigged humanoid (inner#1692)', async () => {
    vi.mocked(httpRequest).mockImplementation(async () => new Response(Uint8Array.from(readFileSync(FIGURE_PATH))));
    const resolve = vi.fn();
    const root = await loadSceneModel({ kind: 'builtin', id: 'figure' }, new AbortController().signal, resolve, '#888888', IMPORT_LIMITS);
    // A built-in source is never resolved as a registered asset.
    expect(resolve).toHaveBeenCalledTimes(0);
    expect(httpRequest).toHaveBeenCalledTimes(1);
    const requested = new URL(String(vi.mocked(httpRequest).mock.calls[0]?.[0]));
    expect(requested.origin).toBe(location.origin);
    expect(requested.pathname).toMatch(/figure[^/]*\.glb$/);
    const skinned: SkinnedMesh[] = [];
    root.traverse((child) => { if (child instanceof SkinnedMesh) skinned.push(child); });
    expect(skinned.length).toBeGreaterThan(0);
    expect(skinned.every((mesh) => mesh.skeleton.bones.length > 0)).toBe(true);
    expect(createPoseRig(root)?.kind).toBe('humanoid');
    // inner#1693 design 5.1: one part per glTF material of the figure.
    expect([...lookModelOf(root)!.table.keys()].sort()).toEqual(['0', '1', '2']);
    disposeModelTemplate(root);
  });

  it('puts each primitive in its glTF material\'s part, one without a material in the default part, and gives it UVs (inner#1693 design 5.1)', async () => {
    vi.mocked(httpRequest).mockImplementation(async () => new Response(partsGlb()));
    const resolve = vi.fn().mockResolvedValue({ url: 'https://assets.example/parts.glb', mimeType: 'model/gltf-binary', sizeBytes: partsGlb().byteLength });
    const root = await loadSceneModel({ kind: 'asset', assetId: 'parts' }, new AbortController().signal, resolve, '#888888', IMPORT_LIMITS);
    const parts: string[] = [];
    let instanced: InstancedMesh | null = null;
    root.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (child instanceof InstancedMesh) instanced = child;
      parts.push((child.material as Material).userData.lookPart as string);
      expect(child.geometry.getAttribute('uv')).toBeDefined();
    });
    expect(parts.sort()).toEqual(['0', '1', 'd']);
    expect(((instanced as InstancedMesh | null)?.material as Material | undefined)?.userData.lookPart).toBe('0');
    expect([...lookModelOf(root)!.table.keys()].sort()).toEqual(['0', '1', 'd']);
    disposeModelTemplate(root);
  });
});
