// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Color, MathUtils, MeshPhysicalMaterial, MeshStandardMaterial, RepeatWrapping, type Material, type Mesh, type Object3D, type Texture,
} from 'three';

import { SCENE_LOOK_PICTURE_COLOR, SCENE_LOOK_REPEAT_MAX, SCENE_LOOK_REPEAT_MIN, type SceneLook, type SceneLookPart } from '@breatic/shared';

import { uploadBytes } from '@web/spaces/three-d/model-texture-metadata';

/** A part's own state when its model loaded: what a field shows when unset and what a reset writes back. */
export interface LookPartEntry {
  materialType: string;
  /** The material's name in the model, or null. */
  name: string | null;
  color: string;
  roughness?: number;
  metalness?: number;
  opacity: number;
  transmission: number;
  emissive?: string;
  emissiveIntensity?: number;
  transparent: boolean;
  depthWrite: boolean;
  alphaTest: number;
  hasMap: boolean;
  /** The own picture's tiling, offset and rotation in degrees, when it has one. */
  mapRepeat?: [number, number];
  mapOffset?: [number, number];
  mapRotation?: number;
  /** A small picture of the own picture, for the part row and the picture field; none for a picture the page cannot draw. */
  thumbnail?: string;
  /** A basic material: only colour, picture and opacity apply. */
  unlit: boolean;
  /** A line or points material: only colour and opacity are offered. */
  line: boolean;
  /** A built-in model, whose own colour is the current theme colour. */
  builtin: boolean;
  /** Extra upload bytes when the own picture gets its own tiling; 0 when its sampler already repeats or it has none. */
  clampBytes: number;
  /**
   * A copy of each of the part's materials as loaded, written back on every apply before the stored fields; GLTFLoader
   * splits one glTF material into variants per primitive (vertex colours, flat shading, points, lines), and each
   * material's `userData.lookOriginal` says which copy is its own.
   */
  originals: Material[];
}

export type LookPartTable = ReadonlyMap<string, LookPartEntry>;

/** Options of one apply. */
export interface ApplyLookOptions {
  /** The current theme's muted foreground, the colour of built-in models. */
  themeColor: string;
  /** A user picture's base texture when it is loaded and usable, otherwise null. */
  picture: (assetId: string) => Texture | null;
}

/** The textures an apply cloned for a material, disposed on its next apply. */
const clones = new WeakMap<Material, Texture[]>();

/**
 * Every material slot of the drawables under a root, highlight overlays skipped.
 * @param root - The object root.
 * @param visit - Called with each material and a setter that replaces it in its slot.
 */
function eachMaterial(root: Object3D, visit: (material: Material, replace: (next: Material) => void) => void): void {
  root.traverse((object) => {
    if (object.userData.lookHighlight) return;
    const drawable = object as Mesh;
    if (!drawable.material) return;
    if (Array.isArray(drawable.material)) {
      const slots = drawable.material;
      slots.forEach((material, index) => visit(material, (next) => { slots[index] = next; }));
    } else visit(drawable.material, (next) => { drawable.material = next; });
  });
}

/** Typed access to the fields the lit material classes carry. */
type Lit = MeshStandardMaterial & Partial<Pick<MeshPhysicalMaterial, 'transmission'>> & { map?: Texture | null; color?: Color };

/**
 * Whether a material draws lines or points, which take only colour and opacity.
 * @param material - The material.
 * @returns True for line and points materials.
 */
function isLineMaterial(material: Material): boolean {
  return material.type === 'LineBasicMaterial' || material.type === 'LineDashedMaterial' || material.type === 'PointsMaterial';
}

/** The longest edge of a part picture's thumbnail, in pixels. */
const THUMBNAIL_EDGE = 64;

/**
 * A small copy of a decoded picture as a data URL.
 * @param image - The texture's image.
 * @returns The thumbnail, or undefined for a compressed or empty picture, or one the page may not read back.
 */
function thumbnailOf(image: unknown): string | undefined {
  const drawable = (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) || image instanceof HTMLImageElement || image instanceof HTMLCanvasElement;
  if (!drawable) return undefined;
  const { width, height } = image as { width: number; height: number };
  if (!width || !height) return undefined;
  const scale = THUMBNAIL_EDGE / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  try {
    context.drawImage(image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL();
  } catch {
    // A picture from another origin cannot be read back; the row shows the part's colour.
    return undefined;
  }
}

/**
 * An offset brought into the range a part takes by whole picture widths, which a repeating picture draws the same.
 * @param offset - The model's own offset.
 * @returns It, or its fraction when it is past 100 either way.
 */
function inOffsetRange(offset: number): number {
  return Math.abs(offset) <= 100 ? offset : offset - Math.trunc(offset);
}

/**
 * A tiling count brought to the nearest one a part takes, keeping its mirroring.
 * @param repeat - The model's own count.
 * @returns It, or the bound it is past.
 */
function inRepeatRange(repeat: number): number {
  return (repeat < 0 ? -1 : 1) * MathUtils.clamp(Math.abs(repeat), SCENE_LOOK_REPEAT_MIN, SCENE_LOOK_REPEAT_MAX);
}

/**
 * What the panel shows for a part, read from one of its materials as loaded.
 * @param material - The material.
 * @param options - How the model was made.
 * @param options.builtin - Whether the model is built in.
 * @returns The part's reported state.
 */
function describePart(material: Material, options: { builtin: boolean }): Omit<LookPartEntry, 'originals'> {
  const lit = material as Lit;
  const map = lit.map ?? null;
  const image = map?.image as { width?: number; height?: number } | undefined;
  const repeats = map !== null && map.wrapS === RepeatWrapping && map.wrapT === RepeatWrapping;
  return {
    materialType: material.type,
    name: material.name || null,
    color: `#${(lit.color ?? new Color(SCENE_LOOK_PICTURE_COLOR)).getHexString()}`,
    ...(lit.isMeshStandardMaterial ? { roughness: lit.roughness, metalness: lit.metalness,
      emissive: `#${lit.emissive.getHexString()}`, emissiveIntensity: lit.emissiveIntensity } : {}),
    opacity: material.opacity,
    transmission: lit.transmission ?? 0,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
    alphaTest: material.alphaTest,
    hasMap: map !== null,
    ...(map ? { mapRepeat: [inRepeatRange(map.repeat.x), inRepeatRange(map.repeat.y)] as [number, number], mapOffset: [inOffsetRange(map.offset.x), inOffsetRange(map.offset.y)] as [number, number],
      mapRotation: MathUtils.euclideanModulo(MathUtils.radToDeg(map.rotation) + 180, 360) - 180, thumbnail: thumbnailOf(map.image) } : {}),
    unlit: material.type === 'MeshBasicMaterial',
    line: isLineMaterial(material),
    builtin: options.builtin,
    clampBytes: map !== null && !repeats && image?.width && image.height ? uploadBytes({ width: image.width, height: image.height }, true) : 0,
  };
}

/**
 * Record each part's own state and put the part key on its material, so object clones carry it (inner#1693 design 5.1).
 * @param root - The model template root.
 * @param partOf - The part a template material belongs to.
 * @param options - How the model was made.
 * @param options.builtin - Whether the model is built in.
 * @returns The part table, first material of each part.
 */
export function buildPartTable(root: Object3D, partOf: (material: Material) => string, options: { builtin: boolean }): Map<string, LookPartEntry> {
  const table = new Map<string, LookPartEntry>();
  const copies = new Map<Material, number>();
  eachMaterial(root, (material) => {
    const part = partOf(material);
    material.userData.lookPart = part;
    const known = table.get(part);
    if (known) {
      // Set before cloning: every reset copies the clone's userData back onto the material.
      if (!copies.has(material)) {
        material.userData.lookOriginal = known.originals.length;
        copies.set(material, known.originals.push(material.clone()) - 1);
      } else material.userData.lookOriginal = copies.get(material);
      // One glTF material drawn as points or lines as well as triangles is a lit part: its triangle variant is reported.
      if (known.line && !isLineMaterial(material)) Object.assign(known, describePart(material, options));
      return;
    }
    copies.set(material, 0);
    material.userData.lookOriginal = 0;
    table.set(part, { ...describePart(material, options), originals: [material.clone()] });
  });
  return table;
}

/**
 * A per-part texture with this tiling, from glTF's KHR_texture_transform origin. A clone of the same image kept from
 * the last apply is retiled in place: tiling is a uniform, while a new clone uploads the whole image again.
 * @param base - The texture the part shows.
 * @param fields - The stored tiling; unset values keep the base's own.
 * @param kept - Clones from the last apply still free to reuse; the one taken is removed.
 * @returns The texture to show.
 */
function tiled(base: Texture, fields: SceneLookPart, kept: Texture[]): Texture {
  const index = kept.findIndex((texture) => texture.source === base.source);
  const reused = index >= 0 ? kept.splice(index, 1)[0] : undefined;
  const texture = reused ?? base.clone();
  if (!reused) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.center.set(0, 0);
    texture.needsUpdate = true;
  }
  texture.repeat.copy(base.repeat);
  texture.offset.copy(base.offset);
  texture.rotation = base.rotation;
  if (fields.mapRepeat) texture.repeat.fromArray(fields.mapRepeat);
  if (fields.mapOffset) texture.offset.fromArray(fields.mapOffset);
  if (fields.mapRotation !== undefined) texture.rotation = MathUtils.degToRad(fields.mapRotation);
  return texture;
}

/**
 * The material a slot shows: its own class, or a physical one while it lets light through.
 * @param current - The object's current material in the slot.
 * @param original - The slot's material as loaded.
 * @param physical - Whether the slot needs the physical class.
 * @returns A material reset to the slot's own values, `current` itself when its class fits.
 */
function resetMaterial(current: Material, original: Material, physical: boolean): Material {
  const fromStandard = physical && original.type !== 'MeshPhysicalMaterial';
  const Target = fromStandard ? MeshPhysicalMaterial : (original.constructor as new () => Material);
  const material = current.constructor === Target ? current : new Target();
  if (fromStandard) {
    MeshStandardMaterial.prototype.copy.call(material as MeshStandardMaterial, original as MeshStandardMaterial);
    // MeshStandardMaterial.copy leaves only STANDARD; the physical program needs both.
    (material as MeshPhysicalMaterial).defines = { STANDARD: '', PHYSICAL: '' };
  } else material.copy(original);
  return material;
}

/**
 * The inputs a look can change that choose a material's shader program in three r173 (WebGLPrograms: `map`, `mapUv`
 * from the picture's UV channel, transmission, and the OPAQUE define from `transparent`); colour, roughness and the
 * other values a look writes are uniforms.
 * @param material - The material.
 * @returns A key that changes exactly when those inputs change.
 */
function programInputs(material: Material): string {
  const lit = material as Lit;
  return `${lit.map ? lit.map.channel : -1}|${(lit.transmission ?? 0) > 0}|${material.transparent}`;
}

/**
 * Write a look onto one object's own materials (inner#1693 design 5.2): each material is reset to its part's own state,
 * then the stored fields apply; a user picture shows only when `picture` returns it, otherwise the own picture and tiling.
 * @param root - The object's instance root, whose materials are its own.
 * @param table - The model's part table.
 * @param look - The object's stored look.
 * @param options - The theme colour and the usable pictures.
 * @returns Whether any material's shader program inputs changed (class, or what programInputs reads).
 */
export function applyLook(root: Object3D, table: LookPartTable, look: SceneLook, options: ApplyLookOptions): { programChanged: boolean } {
  let programChanged = false;
  // Meshes that shared a material share its replacement, as instantiate gave them one clone (model-viewer does the same).
  const replaced = new Map<Material, Material>();
  eachMaterial(root, (current, replace) => {
    const done = replaced.get(current);
    if (done) {
      replace(done);
      return;
    }
    const part = current.userData.lookPart as string | undefined;
    const entry = part === undefined ? undefined : table.get(part);
    if (!part || !entry) return;
    const fields: SceneLookPart = look[part] ?? {};
    const original = entry.originals[current.userData.lookOriginal as number] ?? entry.originals[0]!;
    const line = isLineMaterial(original);
    const lit = original.type !== 'MeshBasicMaterial' && !line;
    const physical = lit && ((fields.transmission ?? 0) > 0 || original.type === 'MeshPhysicalMaterial');
    const before = { type: current.constructor, inputs: programInputs(current), version: current.version };
    const kept = clones.get(current) ?? [];
    clones.delete(current);
    const material = resetMaterial(current, original, physical) as Lit;
    const made: Texture[] = [];

    let showingUser = false;
    if (!line && 'map' in material) {
      const userPicture = fields.map && fields.map !== 'none' ? options.picture(fields.map) : null;
      if (fields.map === 'none') material.map = null;
      else if (userPicture) {
        material.map = tiled(userPicture, fields, kept);
        made.push(material.map);
        showingUser = true;
      } else if (!fields.map && material.map
        && (fields.mapRepeat !== undefined || fields.mapOffset !== undefined || fields.mapRotation !== undefined)) {
        material.map = tiled(material.map, fields, kept);
        made.push(material.map);
      }
    }
    if (material.color) {
      const own = entry.builtin ? options.themeColor : entry.color;
      if (fields.color !== undefined) material.color.set(fields.color);
      else material.color.set(showingUser ? SCENE_LOOK_PICTURE_COLOR : own);
    }
    if (lit) {
      if (fields.roughness !== undefined) material.roughness = fields.roughness;
      if (fields.metalness !== undefined) material.metalness = fields.metalness;
      if (fields.emissive !== undefined) material.emissive.set(fields.emissive);
      if (fields.emissiveIntensity !== undefined) material.emissiveIntensity = fields.emissiveIntensity;
      if (physical) material.transmission = fields.transmission ?? (original as Lit).transmission ?? 0;
    }
    if (fields.opacity !== undefined) {
      material.opacity = fields.opacity;
      if (fields.opacity < 1) {
        material.transparent = true;
        material.depthWrite = false;
      }
    }
    const after = { type: material.constructor, inputs: programInputs(material) };
    if (material === current) {
      // three's transmission setter counts every crossing of 0, the reset's own included; with the same inputs the
      // program is the same, so the count goes back to where it was.
      if (before.inputs !== after.inputs) material.needsUpdate = true;
      else material.version = before.version;
    }
    for (const texture of kept) texture.dispose();
    if (made.length > 0) clones.set(material, made);
    replaced.set(current, material);
    if (material !== current) {
      replace(material);
      current.dispose();
    }
    if (before.type !== after.type || before.inputs !== after.inputs) programChanged = true;
  });
  return { programChanged };
}

/**
 * Release the textures applies cloned for an object's materials, before the object is removed.
 * @param root - The object's instance root.
 */
export function releaseLook(root: Object3D): void {
  eachMaterial(root, (material) => {
    for (const texture of clones.get(material) ?? []) texture.dispose();
    clones.delete(material);
  });
}
