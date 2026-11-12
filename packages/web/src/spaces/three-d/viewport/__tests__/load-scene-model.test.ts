// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Mesh, SkinnedMesh } from 'three';
import { httpRequest } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { disposeModelTemplate, loadSceneModel } from '@web/spaces/three-d/viewport/model-resources';
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
    disposeModelTemplate(root);
  });
});
