// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { createModelDecoder } from '@web/spaces/three-d/viewport/model-decoder-173';

afterEach(() => vi.unstubAllGlobals());

describe('Draco decoder preload that no loaded primitive needs', () => {
  it('releases the worker source created after the decoder was disposed', async () => {
    const gate = Promise.withResolvers<void>();
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => { const url = `blob:worker-${created.length}`; created.push(url); return url; });
      static revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
    });
    // The decoder asset URLs are root-relative under vitest, which the platform Request refuses to parse.
    vi.stubGlobal('Request', class { constructor(readonly url: string) {} });
    vi.stubGlobal('fetch', vi.fn(async () => { await gate.promise; return new Response('decoder'); }));
    const model: ModelPackage = {
      entry: 'scene.gltf',
      files: new Map(),
      json: { asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] },
      support: { webp: true, avif: true },
    };
    const decoder = createModelDecoder(model, IMPORT_LIMITS, undefined, { basisu: false, draco: false });
    await decoder.prepare();
    decoder.dispose();
    gate.resolve();
    await vi.waitFor(() => expect(created).toHaveLength(1));
    await vi.waitFor(() => expect(revoked).toEqual(created));
  });
});
