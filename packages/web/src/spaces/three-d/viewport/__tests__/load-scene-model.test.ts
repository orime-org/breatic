// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '@breatic/shared';
import { disposeModelTemplate, loadSceneModel } from '@web/spaces/three-d/viewport/model-resources';

vi.mock('@breatic/shared', () => ({ httpRequest: vi.fn() }));

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
    const resolve = vi.fn().mockResolvedValue({ url: 'https://assets.example/model.glb', mimeType: 'model/gltf-binary' });
    const signal = new AbortController().signal;
    const root = await loadSceneModel({ kind: 'asset', assetId: 'registered' }, signal, resolve, '#888888');
    expect(resolve).toHaveBeenCalledWith('registered', signal);
    expect(httpRequest).toHaveBeenCalledWith('https://assets.example/model.glb', { method: 'GET' }, { replaySafe: true, signal });
    expect(root.children.map((child) => child.name)).toEqual(['registered-model']);
    disposeModelTemplate(root);
  });

  it('does not transfer an asset after its owner aborted while resolving', async () => {
    const abort = new AbortController();
    const resolve = vi.fn().mockImplementation(async () => {
      abort.abort();
      return { url: 'https://assets.example/model.glb', mimeType: 'model/gltf-binary' };
    });
    await expect(loadSceneModel({ kind: 'asset', assetId: 'registered' }, abort.signal, resolve, '#888888')).rejects.toMatchObject({ name: 'AbortError' });
    expect(httpRequest).toHaveBeenCalledTimes(0);
  });

  it('rejects unsupported types before transfer and malformed binary containers before parsing', async () => {
    const signal = new AbortController().signal;
    const resolve = vi.fn().mockResolvedValue({ url: 'https://assets.example/model.glb', mimeType: 'model/gltf+json' });
    await expect(loadSceneModel({ kind: 'asset', assetId: 'registered' }, signal, resolve, '#888888')).rejects.toThrow('unsupported model type');
    expect(httpRequest).toHaveBeenCalledTimes(0);
    resolve.mockResolvedValue({ url: 'https://assets.example/model.glb', mimeType: 'model/gltf-binary' });
    vi.mocked(httpRequest).mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    await expect(loadSceneModel({ kind: 'asset', assetId: 'registered' }, signal, resolve, '#888888')).rejects.toThrow('not a binary glTF');
  });

  it('builds the project-owned sources without accessing a remote asset', async () => {
    const resolve = vi.fn();
    const root = await loadSceneModel({ kind: 'builtin', id: 'figure' }, new AbortController().signal, resolve, '#888888');
    expect(root.children).toHaveLength(9);
    expect(resolve).toHaveBeenCalledTimes(0);
    expect(httpRequest).toHaveBeenCalledTimes(0);
    disposeModelTemplate(root);
  });
});
