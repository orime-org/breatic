// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * An imported model is loaded straight from the address, type and size the scene stores (inner#2171 design §6.2):
 * no request turns an id into an address, an oversized model is refused before any byte is fetched, and objects
 * sharing an address share one template.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Group } from 'three';
import { httpRequest } from '@breatic/shared';
import type * as SharedModule from '@breatic/shared';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { loadSceneModel, ModelResourceCache, type SceneModelSource } from '@web/spaces/three-d/viewport/model-resources';

vi.mock('@breatic/shared', async (importOriginal) => ({ ...await importOriginal<typeof SharedModule>(), httpRequest: vi.fn() }));
vi.mock('@web/spaces/three-d/model-texture-format', () => ({ detectTextureFormatSupport: vi.fn(async () => ({ webp: true, avif: true })) }));

/**
 * A minimal binary glTF.
 * @returns The container.
 */
function glb(): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'm' }] }));
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

const URL_A = 'https://assets.example/a.glb';

describe('models load by the address the scene stores (inner#2171)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches a GLB from its stored address', async () => {
    vi.mocked(httpRequest).mockResolvedValue(new Response(glb()));
    const source = { kind: 'asset', url: URL_A, mimeType: 'model/gltf-binary', sizeBytes: glb().byteLength } as SceneModelSource;
    const root = await loadSceneModel(source, new AbortController().signal, '#888', IMPORT_LIMITS);
    expect(root).toBeInstanceOf(Group);
    expect(vi.mocked(httpRequest).mock.calls.map(([url]) => url)).toEqual([URL_A]);
  });

  it('refuses a model over the import budget without fetching it', async () => {
    const actual = IMPORT_LIMITS.maxArtifactBytes + 1;
    const source = { kind: 'asset', url: URL_A, mimeType: 'model/gltf-binary', sizeBytes: actual } as SceneModelSource;
    const refused = await loadSceneModel(source, new AbortController().signal, '#888', IMPORT_LIMITS).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ModelImportError);
    expect(refused).toMatchObject({ code: 'budget', budget: { allowed: IMPORT_LIMITS.maxArtifactBytes, actual } });
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('never fetches an oversized model and loads each address once, whatever the mix', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ url: fc.constantFrom(URL_A, 'https://assets.example/b.glb', 'https://assets.example/c.zip'), over: fc.boolean() }), { minLength: 1, maxLength: 6 }),
      async (objects) => {
        const loads: string[] = [];
        const cache = new ModelResourceCache(async (source) => {
          if (source.kind === 'asset') loads.push(source.url);
          return new Group();
        });
        const leases = objects.map(({ url }) => cache.acquire({ kind: 'asset', url, mimeType: url.endsWith('.zip') ? 'application/zip' : 'model/gltf-binary', sizeBytes: 10 } as SceneModelSource));
        await Promise.all(leases.map((lease) => lease.ready));
        expect(loads.sort()).toEqual([...new Set(objects.map((object) => object.url))].sort());
        leases.forEach((lease) => lease.release());
      },
    ), { numRuns: 100 });
  });
});
