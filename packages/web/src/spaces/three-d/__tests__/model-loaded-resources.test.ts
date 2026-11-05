// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { REVISION } from 'three';
import { getUnsupportedModelExtensions, loadedResources } from '@web/spaces/three-d/model-loaded-resources';
import type { GltfDocument } from '@web/spaces/three-d/model-package';
import type { TextureFormatSupport } from '@web/spaces/three-d/model-texture-format';

/**
 * Build a document from declarations alone; loadedResources reads nothing else.
 * @throws {never} Never.
 */
function doc(json: Record<string, unknown>): GltfDocument {
  return { asset: { version: '2.0' }, ...json } as GltfDocument;
}

/**
 * Derive with every texture format decodable, as current desktop browsers report.
 * @throws {never} Never.
 */
function derive(json: Record<string, unknown>, support: TextureFormatSupport = { webp: true, avif: true }): ReturnType<typeof loadedResources> {
  return loadedResources(doc(json), support);
}

/**
 * Give every accessor its own bufferView and buffer, so the loaded buffers name the loaded accessors.
 * @throws {never} Never.
 */
function views(count: number): Record<string, unknown> {
  const indices = Array.from({ length: count }, (_, index) => index);
  return { accessors: indices.map((index) => ({ bufferView: index })), bufferViews: indices.map((index) => ({ buffer: index })) };
}

/**
 * Sort a set for comparison.
 * @throws {never} Never.
 */
function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

describe('loadedResources follows GLTFLoader r173 (inner#1690)', () => {
  it('is derived from the installed loader revision', () => {
    expect(REVISION).toBe('173');
  });

  it('walks only nodes reached from the scenes, their children and animation targets', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }, { nodes: [3] }],
      nodes: [{ children: [1] }, { mesh: 0 }, { mesh: 1 }, { mesh: 2 }, { mesh: 3 }],
      meshes: [0, 1, 2, 3].map((accessor) => ({ primitives: [{ attributes: { POSITION: accessor } }] })),
      animations: [{ channels: [{ sampler: 0, target: { node: 4, path: 'translation' } }], samplers: [{ input: 4, output: 5 }] }],
      ...views(6),
    }));
    expect(sorted(resources.buffers)).toEqual([0, 2, 3, 4, 5]);
  });

  it('loads skin joints shallowly: their mesh, not their children', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, skin: 0 }, { mesh: 1, children: [2] }, { mesh: 2 }],
      skins: [{ joints: [1], inverseBindMatrices: 3 }],
      meshes: [0, 1, 2].map((accessor) => ({ primitives: [{ attributes: { POSITION: accessor } }] })),
      ...views(4),
    }));
    expect(sorted(resources.buffers)).toEqual([0, 1, 3]);
  });

  it('reads instancing attributes only of reached nodes whose mesh draws triangles', () => {
    const resources = derive(({
      scenes: [{ nodes: [0, 1, 2, 3] }],
      nodes: [
        { mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2, SCALE: 3 } } } },
        { mesh: 1, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 4 } } } },
        { extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 5 } } } },
        { mesh: 2, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 6 } } } },
      ],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 } }, { mode: 5, attributes: { POSITION: 0 } }] },
        { primitives: [{ mode: 0, attributes: { POSITION: 1 } }] },
        { primitives: [{ mode: 4, attributes: { POSITION: 1 } }, { mode: 1, attributes: { POSITION: 1 } }] },
      ],
      ...views(7),
    }));
    expect(sorted(resources.buffers)).toEqual([0, 1, 2, 3]);
  });

  it('skips animation channels without a target node and samplers no channel uses', () => {
    const resources = derive(({
      scenes: [{ nodes: [] }],
      nodes: [{}],
      animations: [{
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }, { sampler: 1, target: { path: 'pointer' } }],
        samplers: [{ input: 0, output: 1 }, { input: 2, output: 3 }, { input: 4, output: 5 }],
      }],
      ...views(6),
    }));
    expect(sorted(resources.buffers)).toEqual([0, 1]);
  });

  it('reads morph targets only for POSITION, NORMAL and COLOR_0', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, targets: [{ POSITION: 2, NORMAL: 3, COLOR_0: 4, TANGENT: 5, TEXCOORD_0: 6 }] }] }],
      ...views(7),
    }));
    expect(sorted(resources.buffers)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reads the compressed view of a Draco primitive in place of the attributes and indices it decodes', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [
        { attributes: { POSITION: 0, _ID: 1 }, indices: 2, extensions: { KHR_draco_mesh_compression: { bufferView: 6, attributes: { POSITION: 0 } } } },
        { mode: 0, attributes: { POSITION: 3 }, indices: 4, extensions: { KHR_draco_mesh_compression: { bufferView: 7, attributes: { POSITION: 0 } } } },
      ] }],
      ...views(8),
    }));
    expect(sorted(resources.buffers)).toEqual([1, 4, 6, 7]);
  });

  it('reads a meshopt view from the extension buffer', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0 }],
      bufferViews: [{ buffer: 0, extensions: { EXT_meshopt_compression: { buffer: 1 } } }],
    }));
    expect(sorted(resources.buffers)).toEqual([1]);
  });

  it('falls back to the texture source when a declared WebP is unsupported, without trying AVIF', () => {
    const json = {
      scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0, extensions: { EXT_texture_webp: { source: 1 }, EXT_texture_avif: { source: 2 } } }],
      images: [{ uri: 'c.png' }, { uri: 'c.webp' }, { uri: 'c.avif' }],
    };
    expect(derive(json, { webp: false, avif: true }).textures).toEqual([{ texture: 0, image: 0 }]);
    expect(derive(json, { webp: true, avif: true }).textures).toEqual([{ texture: 0, image: 1 }]);
  });

  it('reads textures only of materials reached primitives use, by the slots the loader assigns', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }, { attributes: {}, material: 1 }] }],
      materials: [
        { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 }, extensions: { KHR_materials_unlit: {}, KHR_materials_clearcoat: { clearcoatTexture: { index: 2 } } } },
        { pbrMetallicRoughness: { metallicRoughnessTexture: { index: 3 } }, occlusionTexture: { index: 4 }, emissiveTexture: { index: 5 },
          extras: { lightTexture: { index: 6 } },
          extensions: { KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 7 }, extras: { bakedTexture: { index: 6 } }, vendorData: { bakedTexture: { index: 9 } }, bakedTexture: { index: 9 } },
            VENDOR_material: { someTexture: { index: 8 } } } },
        { pbrMetallicRoughness: { baseColorTexture: { index: 9 } } },
      ],
      textures: Array.from({ length: 10 }, (_, source) => ({ source })),
      images: Array.from({ length: 10 }, () => ({ uri: 'texture.png' })),
    }));
    expect(resources.textures.map(({ texture }) => texture)).toEqual([0, 3, 4, 5, 7]);
  });

  it('picks the first supported source extension, in plugin order, over the texture source', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 }, emissiveTexture: { index: 2 } }],
      textures: [
        { source: 0, extensions: { EXT_texture_webp: { source: 1 }, KHR_texture_basisu: { source: 2 } } },
        { source: 3, extensions: { EXT_texture_avif: { source: 4 }, MSFT_texture_dds: { source: 5 } } },
        { source: 6, extensions: { MSFT_texture_dds: { source: 7 } } },
      ],
      images: Array.from({ length: 8 }, () => ({ uri: 'texture.png' })),
    }));
    expect(resources.textures).toEqual([{ texture: 0, image: 2 }, { texture: 1, image: 4 }, { texture: 2, image: 6 }]);
    expect(sorted(resources.images)).toEqual([2, 4, 6]);
  });

  it('reads the buffer of an image a loaded texture decodes from a bufferView', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
      bufferViews: [{ buffer: 2 }],
    }));
    expect(sorted(resources.buffers)).toEqual([2]);
  });

  it('leaves the image undefined when a used texture names none or a missing one', () => {
    const resources = derive(({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
      textures: [{}, { source: 7 }],
      images: [{ uri: 'texture.png' }],
    }));
    expect(resources.textures).toEqual([{ texture: 0, image: undefined }, { texture: 1, image: undefined }]);
    expect(resources.images.size).toBe(0);
  });

  it('falls back to the texture source when the browser cannot decode the source extension, as GLTFLoader does', () => {
    const json = {
      scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }],
      textures: [{ source: 0, extensions: { EXT_texture_avif: { source: 1 } } }, { source: 2, extensions: { EXT_texture_webp: { source: 3 } } }],
      images: Array.from({ length: 4 }, () => ({ uri: 'texture.png' })),
    };
    expect(derive(json).textures).toEqual([{ texture: 0, image: 1 }, { texture: 1, image: 3 }]);
    expect(derive(json, { webp: false, avif: false }).textures).toEqual([{ texture: 0, image: 0 }, { texture: 1, image: 2 }]);
  });

  it('reports Draco only when a reached primitive is Draco compressed', () => {
    const draco = { KHR_draco_mesh_compression: { bufferView: 0, attributes: {} } };
    expect(derive({ scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: {}, extensions: draco }] }] }).draco).toBe(true);
    expect(derive({ extensionsUsed: ['KHR_draco_mesh_compression'], scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: {} }] }, { primitives: [{ attributes: {}, extensions: draco }] }] }).draco).toBe(false);
  });
});

describe('required texture formats this browser cannot decode', () => {
  /**
   * A glTF document that requires the given extensions.
   * @param required - The extensionsRequired list.
   * @returns The document.
   * @throws {never} Never.
   */
  const requiring = (required: string[]): GltfDocument => ({ asset: { version: '2.0' }, extensionsUsed: required, extensionsRequired: required });

  it('names a required AVIF or WebP format as unsupported where this browser cannot decode it', () => {
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_avif']), { webp: true, avif: false }).required).toEqual(['EXT_texture_avif']);
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_webp']), { webp: false, avif: true }).required).toEqual(['EXT_texture_webp']);
  });

  it('accepts a required AVIF or WebP format this browser decodes', () => {
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_avif', 'EXT_texture_webp']), { webp: true, avif: true }).required).toEqual([]);
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_webp']), { webp: true, avif: false }).required).toEqual([]);
    expect(getUnsupportedModelExtensions(requiring(['EXT_texture_avif']), { webp: false, avif: true }).required).toEqual([]);
  });
});
