// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GltfDocument } from '@web/spaces/three-d/model-package';

/** Material extensions whose textures GLTFLoader r173 loads through its registered plugins. */
const MATERIAL_TEXTURE_EXTENSIONS: ReadonlySet<string> = new Set([
  'KHR_materials_clearcoat', 'KHR_materials_dispersion', 'KHR_materials_iridescence', 'KHR_materials_sheen',
  'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_specular', 'KHR_materials_anisotropy', 'EXT_materials_bump',
]);
/** Texture source extensions GLTFLoader r173 tries, in its plugin order, before a texture's own source. */
const TEXTURE_SOURCE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const;

/** A texture GLTFLoader loads, with the image it decodes, or undefined when the declaration names none. */
export interface LoadedTexture {
  texture: number;
  image: number | undefined;
}
/** The textures, images and buffers GLTFLoader actually loads for a model. */
export interface LoadedResources {
  textures: readonly LoadedTexture[];
  images: ReadonlySet<number>;
  buffers: ReadonlySet<number>;
}

type JsonObject = Record<string, unknown>;

/**
 * Read a JSON value as an object.
 * @param value - Any parsed JSON value.
 * @returns The value when it is a plain object.
 * @throws {never} Never.
 */
function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

/**
 * Read a JSON value as an array.
 * @param value - Any parsed JSON value.
 * @returns The array, or an empty one.
 * @throws {never} Never.
 */
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Read a non-negative integer index.
 * @param value - Any parsed JSON value.
 * @returns The index, or undefined when the value is not one.
 * @throws {never} Never.
 */
function index(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

/**
 * Collect every texture index a material slot object refers to, at any depth.
 * @param value - A material or one of its supported extension objects.
 * @param into - Texture indices found so far.
 * @throws {never} Never.
 */
function collectTextureSlots(value: unknown, into: Set<number>): void {
  const node = object(value);
  if (!node) return;
  for (const [key, child] of Object.entries(node)) {
    if (key === 'extensions') continue;
    const slot = key.endsWith('Texture') ? index(object(child)?.index) : undefined;
    if (slot !== undefined) into.add(slot);
    else collectTextureSlots(child, into);
  }
}

/**
 * Pick the image GLTFLoader decodes for a texture: the first supported source extension, otherwise the texture's source.
 * @param texture - The texture declaration.
 * @returns The image index, or undefined when none is declared.
 * @throws {never} Never.
 */
function textureImage(texture: JsonObject | undefined): number | undefined {
  const extensions = object(texture?.extensions);
  for (const name of TEXTURE_SOURCE_EXTENSIONS) {
    const source = index(object(extensions?.[name])?.source);
    if (source !== undefined) return source;
  }
  return index(texture?.source);
}

/**
 * Derive the resources GLTFLoader r173 loads: textures the materials use, the images those decode and the buffers geometry and images read.
 * Checks run on exactly these, so a declaration the loader never touches cannot refuse a model it renders.
 * @param json - The checked glTF document.
 * @returns The loaded textures, images and buffers by index.
 * @throws {never} Never.
 */
export function loadedResources(json: GltfDocument): LoadedResources {
  const document = json as JsonObject;
  const textureIndices = new Set<number>();
  for (const material of array(document.materials)) {
    const node = object(material);
    collectTextureSlots(node, textureIndices);
    for (const [name, extension] of Object.entries(object(node?.extensions) ?? {})) {
      if (MATERIAL_TEXTURE_EXTENSIONS.has(name)) collectTextureSlots(extension, textureIndices);
    }
  }
  const textureDefinitions = array(document.textures);
  const textures = [...textureIndices].sort((a, b) => a - b).map((texture) => ({ texture, image: textureImage(object(textureDefinitions[texture])) }));
  const images = new Set(textures.flatMap(({ image }) => image === undefined ? [] : [image]));
  const views = new Set<number>();
  for (const image of images) {
    const view = index(object(array(document.images)[image])?.bufferView);
    if (view !== undefined) views.add(view);
  }
  const accessors = new Set<number>();
  for (const mesh of array(document.meshes)) {
    for (const primitive of array(object(mesh)?.primitives)) {
      const node = object(primitive);
      const draco = index(object(object(node?.extensions)?.KHR_draco_mesh_compression)?.bufferView);
      if (draco !== undefined) views.add(draco);
      for (const value of [...Object.values(object(node?.attributes) ?? {}), node?.indices,
        ...array(node?.targets).flatMap((target) => Object.values(object(target) ?? {}))]) {
        const accessor = index(value);
        if (accessor !== undefined) accessors.add(accessor);
      }
    }
  }
  for (const skin of array(document.skins)) {
    const accessor = index(object(skin)?.inverseBindMatrices);
    if (accessor !== undefined) accessors.add(accessor);
  }
  for (const animation of array(document.animations)) {
    for (const sampler of array(object(animation)?.samplers)) {
      for (const value of [object(sampler)?.input, object(sampler)?.output]) {
        const accessor = index(value);
        if (accessor !== undefined) accessors.add(accessor);
      }
    }
  }
  for (const accessor of accessors) {
    const node = object(array(document.accessors)[accessor]);
    for (const view of [node?.bufferView, object(object(node?.sparse)?.indices)?.bufferView, object(object(node?.sparse)?.values)?.bufferView]) {
      const viewIndex = index(view);
      if (viewIndex !== undefined) views.add(viewIndex);
    }
  }
  const buffers = new Set<number>();
  for (const view of views) {
    const node = object(array(document.bufferViews)[view]);
    // A meshopt-compressed view reads only the extension's buffer; its own buffer is the uncompressed fallback.
    const meshopt = object(object(node?.extensions)?.EXT_meshopt_compression);
    const buffer = index(meshopt ? meshopt.buffer : node?.buffer);
    if (buffer !== undefined) buffers.add(buffer);
  }
  return { textures, images, buffers };
}
