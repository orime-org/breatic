// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { createModelDecoder, getUnsupportedModelExtensions } from '@web/spaces/three-d/viewport/model-decoder-173';

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

describe('required texture formats this browser cannot decode', () => {
  /**
   * A model package that requires the given extensions.
   * @param required - The extensionsRequired list.
   * @param support - This browser's WebP and AVIF support.
   * @returns The package.
   * @throws {never} Never.
   */
  function requiring(required: string[], support: { webp: boolean; avif: boolean }): ModelPackage {
    return { entry: 'scene.gltf', files: new Map(), json: { asset: { version: '2.0' }, extensionsUsed: required, extensionsRequired: required }, support };
  }

  it('names a required AVIF or WebP format as unsupported where this browser cannot decode it', () => {
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_avif'], { webp: true, avif: false })).required).toEqual(['EXT_texture_avif']);
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_webp'], { webp: false, avif: false })).required).toEqual(['EXT_texture_webp']);
    expect(() => createModelDecoder(requiring(['EXT_texture_avif'], { webp: true, avif: false }), IMPORT_LIMITS, undefined, { basisu: false, draco: false }))
      .toThrow(expect.objectContaining({ code: 'unsupported', detail: 'EXT_texture_avif' }));
  });

  it('accepts a required AVIF or WebP format this browser decodes', () => {
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_avif', 'EXT_texture_webp'], { webp: true, avif: true })).required).toEqual([]);
  });
});

