// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GltfDocument } from '@web/spaces/three-d/model-package';
import type { TextureFormatSupport } from '@web/spaces/three-d/model-texture-format';

/** The texture slots each GLTFLoader r173 material plugin reads (GLTFLoader.js 784-1367). */
const MATERIAL_TEXTURE_SLOTS: Readonly<Record<string, readonly string[]>> = {
  KHR_materials_clearcoat: ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture'],
  KHR_materials_iridescence: ['iridescenceTexture', 'iridescenceThicknessTexture'],
  KHR_materials_sheen: ['sheenColorTexture', 'sheenRoughnessTexture'],
  KHR_materials_transmission: ['transmissionTexture'],
  KHR_materials_volume: ['thicknessTexture'],
  KHR_materials_specular: ['specularTexture', 'specularColorTexture'],
  KHR_materials_anisotropy: ['anisotropyTexture'],
  EXT_materials_bump: ['bumpTexture'],
};
/** Texture source extensions GLTFLoader r173 tries, in its plugin order, before a texture's own source. */
const TEXTURE_SOURCE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const;
/** Primitive modes GLTFMeshGpuInstancing accepts: undefined (TRIANGLES), TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN. */
const TRIANGLE_MODES: ReadonlySet<unknown> = new Set([undefined, 4, 5, 6]);
/** Morph target attributes GLTFLoader r173 reads (addMorphTargets). */
const MORPH_ATTRIBUTES = ['POSITION', 'NORMAL', 'COLOR_0'] as const;

/** Capabilities registered by the installed r173 GLTFLoader and its decoders. */
const SUPPORTED_REQUIRED_EXTENSIONS: ReadonlySet<string> = new Set([
  'KHR_binary_glTF', 'KHR_draco_mesh_compression', 'KHR_lights_punctual',
  'KHR_materials_clearcoat', 'KHR_materials_dispersion', 'KHR_materials_ior',
  'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission',
  'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_materials_unlit',
  'KHR_materials_volume', 'KHR_texture_basisu', 'KHR_texture_transform',
  'KHR_mesh_quantization', 'KHR_materials_emissive_strength', 'EXT_materials_bump',
  'EXT_texture_webp', 'EXT_texture_avif', 'EXT_meshopt_compression', 'EXT_mesh_gpu_instancing',
]);

/**
 * Whether a browser cannot decode the texture format an extension names, as GLTFLoader's WebP and AVIF probes decide.
 * @param name - An extension identifier.
 * @param support - The browser's WebP and AVIF support.
 * @returns True for WebP or AVIF the browser cannot decode.
 * @throws {never} Never.
 */
function undecodable(name: string, support: TextureFormatSupport): boolean {
  return (name === 'EXT_texture_webp' && !support.webp) || (name === 'EXT_texture_avif' && !support.avif);
}

/**
 * Report extensions outside the capabilities registered by this exact loader, and required WebP or AVIF textures this browser cannot decode.
 * @param json - The glTF document with its original extension declarations.
 * @param support - This browser's WebP and AVIF support.
 * @returns Unsupported required and optional extension identifiers.
 * @throws {never} Never.
 */
export function getUnsupportedModelExtensions(json: GltfDocument, support: TextureFormatSupport): { required: string[]; optional: string[] } {
  const required = json.extensionsRequired?.filter((value) => !SUPPORTED_REQUIRED_EXTENSIONS.has(value) || undecodable(value, support)) ?? [];
  const requiredSet = new Set(json.extensionsRequired ?? []);
  const optional = json.extensionsUsed?.filter((value) => !SUPPORTED_REQUIRED_EXTENSIONS.has(value) && !requiredSet.has(value)) ?? [];
  return { required, optional };
}

/** A texture GLTFLoader loads, with the image it decodes, or undefined when the declaration names no existing image. */
interface LoadedTexture {
  texture: number;
  image: number | undefined;
}
/** The textures, images and buffers GLTFLoader actually loads for a model. */
export interface LoadedResources {
  textures: readonly LoadedTexture[];
  images: ReadonlySet<number>;
  buffers: ReadonlySet<number>;
  /** Whether a loaded texture decodes through KHR_texture_basisu, which GLTFLoader uses whether or not extensionsUsed lists it. */
  basisu: boolean;
  /** Whether a reached primitive is Draco compressed, the only case in which GLTFLoader waits for the Draco decoder. */
  draco: boolean;
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
 * Collect the textures GLTFLoader assigns for one material: an unlit material reads only its base colour.
 * @param material - The material declaration.
 * @param into - Texture indices found so far.
 * @throws {never} Never.
 */
function collectMaterialTextures(material: JsonObject | undefined, into: Set<number>): void {
  const pbr = object(material?.pbrMetallicRoughness);
  const extensions = object(material?.extensions);
  const slots = extensions?.KHR_materials_unlit ? [pbr?.baseColorTexture]
    : [pbr?.baseColorTexture, pbr?.metallicRoughnessTexture, material?.normalTexture, material?.occlusionTexture, material?.emissiveTexture];
  for (const slot of slots) {
    const texture = index(object(slot)?.index);
    if (texture !== undefined) into.add(texture);
  }
  if (extensions?.KHR_materials_unlit) return;
  for (const [name, slotNames] of Object.entries(MATERIAL_TEXTURE_SLOTS)) {
    const extension = object(extensions?.[name]);
    for (const slot of slotNames) {
      const texture = index(object(extension?.[slot])?.index);
      if (texture !== undefined) into.add(texture);
    }
  }
}

/**
 * Pick the image GLTFLoader decodes for a texture: the first source extension the texture declares, or the texture's own source
 * when this browser cannot decode that extension's format (GLTFLoader's WebP and AVIF plugins fall back without trying another).
 * @param texture - The texture declaration.
 * @param support - The browser's WebP and AVIF support, which GLTFLoader probes before using those extensions.
 * @returns The image index, or undefined when none is declared, and the source extension that supplies it.
 * @throws {never} Never.
 */
function textureImage(texture: JsonObject | undefined, support: TextureFormatSupport): { image: number | undefined; extension: string | undefined } {
  const extensions = object(texture?.extensions);
  for (const name of TEXTURE_SOURCE_EXTENSIONS) {
    const source = index(object(extensions?.[name])?.source);
    if (source === undefined) continue;
    if (undecodable(name, support)) break;
    return { image: source, extension: name };
  }
  return { image: index(texture?.source), extension: undefined };
}

/**
 * Derive the resources GLTFLoader r173 loads, by walking what it walks: every scene's nodes and every animation target, their children,
 * skin joints (their own mesh only), the reached meshes, the materials their primitives use and the slots each material assigns.
 * Checks run on exactly these, so a declaration the loader never touches cannot refuse a model it renders.
 * @param json - The checked glTF document.
 * @param support - The browser's WebP and AVIF support.
 * @returns The loaded textures (image undefined when the texture names no existing image), images and buffers by index, and whether KTX2 or Draco decoding is needed.
 * @throws {never} Never.
 */
export function loadedResources(json: GltfDocument, support: TextureFormatSupport): LoadedResources {
  const document = json as JsonObject;
  const nodes = array(document.nodes);
  const accessors = new Set<number>();
  const views = new Set<number>();
  const materials = new Set<number>();
  const meshes = new Set<number>();
  /** Nodes loaded with their children and skin (true) or only their own mesh, as skin joints are (false). */
  const reached = new Map<number, boolean>();
  /**
   * Record an accessor index when the value is one.
   * @param value - A declared accessor reference.
   * @throws {never} Never.
   */
  const addAccessor = (value: unknown): void => {
    const accessor = index(value);
    if (accessor !== undefined) accessors.add(accessor);
  };
  /**
   * Load a node as GLTFParser.loadNode (deep) or _loadNodeShallow (joints) does.
   * @param nodeIndex - The node, when the reference is a valid index.
   * @param deep - Whether its children and skin load too.
   * @throws {never} Never.
   */
  const visitNode = (nodeIndex: number | undefined, deep: boolean): void => {
    if (nodeIndex === undefined || reached.get(nodeIndex) === true || (!deep && reached.has(nodeIndex))) return;
    reached.set(nodeIndex, deep);
    const node = object(nodes[nodeIndex]);
    const mesh = index(node?.mesh);
    if (mesh !== undefined) {
      meshes.add(mesh);
      // GLTFMeshGpuInstancing.createNodeMesh reads instance attributes only for a mesh drawn entirely as triangles.
      const triangles = array(object(array(document.meshes)[mesh])?.primitives).every((primitive) => TRIANGLE_MODES.has(object(primitive)?.mode));
      if (triangles) for (const value of Object.values(object(object(object(node?.extensions)?.EXT_mesh_gpu_instancing)?.attributes) ?? {})) addAccessor(value);
    }
    if (!deep) return;
    for (const child of array(node?.children)) visitNode(index(child), true);
    const skin = object(array(document.skins)[index(node?.skin) ?? -1]);
    if (!skin) return;
    addAccessor(skin.inverseBindMatrices);
    for (const joint of array(skin.joints)) visitNode(index(joint), false);
  };
  for (const scene of array(document.scenes)) {
    for (const node of array(object(scene)?.nodes)) visitNode(index(node), true);
  }
  for (const animation of array(document.animations)) {
    const samplers = array(object(animation)?.samplers);
    for (const channel of array(object(animation)?.channels)) {
      const target = index(object(object(channel)?.target)?.node);
      if (target === undefined) continue;
      visitNode(target, true);
      const sampler = object(samplers[index(object(channel)?.sampler) ?? -1]);
      addAccessor(sampler?.input);
      addAccessor(sampler?.output);
    }
  }
  let dracoUsed = false;
  for (const meshIndex of meshes) {
    for (const primitive of array(object(array(document.meshes)[meshIndex])?.primitives)) {
      const node = object(primitive);
      const material = index(node?.material);
      if (material !== undefined) materials.add(material);
      const draco = object(object(node?.extensions)?.KHR_draco_mesh_compression);
      if (draco) dracoUsed = true;
      const decoded = object(draco?.attributes) ?? {};
      const dracoView = index(draco?.bufferView);
      if (dracoView !== undefined) views.add(dracoView);
      for (const [name, value] of Object.entries(object(node?.attributes) ?? {})) if (!(name in decoded)) addAccessor(value);
      // Decoded Draco triangles carry their own index; a point cloud has none and still reads the declared indices.
      if (!draco || node?.mode === 0) addAccessor(node?.indices);
      for (const target of array(node?.targets)) for (const name of MORPH_ATTRIBUTES) addAccessor(object(target)?.[name]);
    }
  }
  const textureIndices = new Set<number>();
  for (const material of materials) collectMaterialTextures(object(array(document.materials)[material]), textureIndices);
  const textureDefinitions = array(document.textures);
  const imageDefinitions = array(document.images);
  let basisu = false;
  const textures = [...textureIndices].sort((a, b) => a - b).map((texture) => {
    const { image, extension } = textureImage(object(textureDefinitions[texture]), support);
    if (extension === 'KHR_texture_basisu') basisu = true;
    return { texture, image: image !== undefined && object(imageDefinitions[image]) ? image : undefined };
  });
  const images = new Set(textures.flatMap(({ image }) => image === undefined ? [] : [image]));
  for (const image of images) {
    const view = index(object(imageDefinitions[image])?.bufferView);
    if (view !== undefined) views.add(view);
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
  return { textures, images, buffers, basisu, draco: dracoUsed };
}

/**
 * Derive the resources GLTFLoader loads in every browser that can open the model: each combination of WebP and AVIF support,
 * except those lacking a format the model lists in extensionsRequired, which GLTFLoader refuses outright.
 * A registered package is shared with collaborators whose browsers may decode a texture from a different source than the importer's.
 * @param json - The checked glTF document.
 * @returns The loaded resources for each such browser.
 * @throws {never} Never.
 */
export function loadedResourcesInEveryBrowser(json: GltfDocument): LoadedResources[] {
  const required = new Set(json.extensionsRequired ?? []);
  return [false, true].flatMap((webp) => [false, true].map((avif) => ({ webp, avif })))
    .filter((support) => ![...required].some((name) => undecodable(name, support)))
    .map((support) => loadedResources(json, support));
}

