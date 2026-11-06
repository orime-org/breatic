// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it, vi } from 'vitest';
import { strToU8 } from 'three/addons/libs/fflate.module.js';
import { IMPORT_LIMITS, TEXTURE_FORMATS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { inspectModelFiles } from '@web/spaces/three-d/model-package';
import { parseSceneModel } from '@web/spaces/three-d/viewport/model-resources';

vi.mock('@web/spaces/three-d/viewport/model-decoder-173', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/spaces/three-d/viewport/model-decoder-173')>(),
  validateModelTextures: vi.fn(() => { throw new RangeError('Invalid typed array length'); }),
}));

describe('failures after GLTFLoader parsed the model (inner#1690)', () => {
  it('judge the model content whatever their type', async () => {
    const triangle = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...triangle))}` }],
      bufferViews: [{ buffer: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] }] };
    const model = inspectModelFiles(new Map([['scene.gltf', Uint8Array.from(strToU8(JSON.stringify(json)))]]), 'scene.gltf', IMPORT_LIMITS, TEXTURE_FORMATS);
    await expect(parseSceneModel(model, new AbortController().signal, IMPORT_LIMITS))
      .rejects.toMatchObject({ name: 'ModelImportError', code: 'invalid', message: 'Invalid typed array length' });
  });
});
