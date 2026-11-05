// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8 } from 'three/addons/libs/fflate.module.js';
import { IMPORT_LIMITS, TEXTURE_FORMATS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { inspectModelFiles } from '@web/spaces/three-d/model-package';
import { parseSceneModel } from '@web/spaces/three-d/viewport/model-resources';

// jsdom has no KTX2 transcoder; the decoded texture reports the mip bytes a transcoded one would.
vi.mock('@web/spaces/three-d/viewport/model-decoder-173', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/spaces/three-d/viewport/model-decoder-173')>(),
  measuredTextureBytes: vi.fn(() => IMPORT_LIMITS.maxTextureBytes + 1),
}));

afterEach(() => vi.unstubAllGlobals());

describe('decoded mip bytes reach the cumulative budget (inner#1690)', () => {
  it('counts the bytes measured on a decoded texture', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPf8AAAAASUVORK5CYII='), (value) => value.charCodeAt(0));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })));
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:texture');
      static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png)));
    const triangle = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }], images: [{ uri: 'color.png' }],
      buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...triangle))}` }],
      bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] }] };
    const model = inspectModelFiles(new Map([['scene.gltf', Uint8Array.from(strToU8(JSON.stringify(json)))], ['color.png', png]]), 'scene.gltf', IMPORT_LIMITS, TEXTURE_FORMATS);
    await expect(parseSceneModel(model, new AbortController().signal, IMPORT_LIMITS)).rejects.toMatchObject({
      code: 'budget', budget: { limit: 'textureBytes', allowed: IMPORT_LIMITS.maxTextureBytes, actual: IMPORT_LIMITS.maxTextureBytes + 1 },
    });
  });
});
