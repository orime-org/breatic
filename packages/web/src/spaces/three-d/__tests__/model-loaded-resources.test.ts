// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { loadedResources } from '@web/spaces/three-d/model-loaded-resources';
import type { GltfDocument } from '@web/spaces/three-d/model-package';

/**
 * Build a document from declarations alone; loadedResources reads nothing else.
 * @throws {never} Never.
 */
function doc(json: Record<string, unknown>): GltfDocument {
  return { asset: { version: '2.0' }, ...json } as GltfDocument;
}

describe('loadedResources follows GLTFLoader r173 (inner#1690)', () => {
  it('picks the first supported source extension, in plugin order, over the texture source', () => {
    const resources = loadedResources(doc({
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 }, emissiveTexture: { index: 2 } }],
      textures: [
        { source: 0, extensions: { EXT_texture_webp: { source: 1 }, KHR_texture_basisu: { source: 2 } } },
        { source: 3, extensions: { EXT_texture_avif: { source: 4 }, MSFT_texture_dds: { source: 5 } } },
        { source: 6, extensions: { MSFT_texture_dds: { source: 7 } } },
      ],
    }));
    expect(resources.textures).toEqual([{ texture: 0, image: 2 }, { texture: 1, image: 4 }, { texture: 2, image: 6 }]);
    expect([...resources.images].sort()).toEqual([2, 4, 6]);
  });

  it('collects textures from supported material extensions and ignores unused or unsupported ones', () => {
    const resources = loadedResources(doc({
      materials: [{ occlusionTexture: { index: 0 }, extensions: {
        KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 1 } },
        VENDOR_unknown_material: { someTexture: { index: 2 } },
      } }],
      textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
    }));
    expect(resources.textures.map(({ texture }) => texture)).toEqual([0, 1]);
  });

  it('reads buffers through geometry, skins, animations, image views and compression extensions', () => {
    const resources = loadedResources(doc({
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, targets: [{ POSITION: 2 }],
        extensions: { KHR_draco_mesh_compression: { bufferView: 3 } } }] }],
      skins: [{ inverseBindMatrices: 4 }],
      animations: [{ samplers: [{ input: 5, output: 5 }] }],
      accessors: [{ bufferView: 0 }, { bufferView: 1 }, { bufferView: 2 }, {}, { bufferView: 4 }, { bufferView: 5 }],
      bufferViews: [{ buffer: 0 }, { buffer: 1 }, { buffer: 2 }, { buffer: 3 }, { buffer: 4 },
        { buffer: 5, extensions: { EXT_meshopt_compression: { buffer: 6 } } }, { buffer: 7 }, { buffer: 8 }],
      images: [{ bufferView: 6 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
    }));
    expect([...resources.buffers].sort()).toEqual([0, 1, 2, 3, 4, 6, 7]);
  });
});
