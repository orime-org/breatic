// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Color, MathUtils, MeshPhysicalMaterial, MeshStandardMaterial, RepeatWrapping, type Material, type Mesh, type Object3D, type Texture,
} from 'three';

import type { SceneLook, SceneLookPart } from '@breatic/shared';

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
  /** A basic material: only colour, picture and opacity apply. */
  unlit: boolean;
  /** A line or points material: only colour and opacity are offered. */
  line: boolean;
  /** A built-in model, whose own colour is the current theme colour. */
  builtin: boolean;
  /** Extra upload bytes when the own picture gets its own tiling; 0 when its sampler already repeats or it has none. */
  clampBytes: number;
  /** A copy of the material as loaded, written back on every apply before the stored fields. */
  original: Material;
}

export type LookPartTable = ReadonlyMap<string, LookPartEntry>;

/** Options of one apply. */
export interface ApplyLookOptions {
  /** The current theme's muted foreground, the colour of built-in models. */
  themeColor: string;
  /** A user picture's base texture when it is loaded and usable, otherwise null. */
  picture: (assetId: string) => Texture | null;
}

/** A material colour of white, which a user picture shows at unless a colour is stored. */
const WHITE = 0xffffff;

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
 * Record each part's own state and put the part key on its material, so object clones carry it (inner#1693 design 5.1).
 * @param root - The model template root.
 * @param partOf - The part a template material belongs to.
 * @param options - How the model was made.
 * @param options.builtin - Whether the model is built in.
 * @returns The part table, first material of each part.
 */
export function buildPartTable(root: Object3D, partOf: (material: Material) => string, options: { builtin: boolean }): Map<string, LookPartEntry> {
  const table = new Map<string, LookPartEntry>();
  eachMaterial(root, (material) => {
    const part = partOf(material);
    material.userData.lookPart = part;
    if (table.has(part)) return;
    const lit = material as Lit;
    const map = lit.map ?? null;
    const image = map?.image as { width?: number; height?: number } | undefined;
    const repeats = map !== null && map.wrapS === RepeatWrapping && map.wrapT === RepeatWrapping;
    table.set(part, {
      materialType: material.type,
      name: material.name || null,
      color: `#${(lit.color ?? new Color(WHITE)).getHexString()}`,
      ...(lit.isMeshStandardMaterial ? { roughness: lit.roughness, metalness: lit.metalness,
        emissive: `#${lit.emissive.getHexString()}`, emissiveIntensity: lit.emissiveIntensity } : {}),
      opacity: material.opacity,
      transmission: lit.transmission ?? 0,
      transparent: material.transparent,
      depthWrite: material.depthWrite,
      alphaTest: material.alphaTest,
      hasMap: map !== null,
      unlit: material.type === 'MeshBasicMaterial',
      line: material.type === 'LineBasicMaterial' || material.type === 'LineDashedMaterial' || material.type === 'PointsMaterial',
      builtin: options.builtin,
      clampBytes: map !== null && !repeats && image?.width && image.height ? uploadBytes({ width: image.width, height: image.height }, true) : 0,
      original: material.clone(),
    });
  });
  return table;
}

/**
 * A per-part texture with this tiling, from glTF's KHR_texture_transform origin.
 * @param base - The texture to clone.
 * @param fields - The stored tiling; unset values keep the base's own.
 * @returns The clone.
 */
function tiled(base: Texture, fields: SceneLookPart): Texture {
  const texture = base.clone();
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.center.set(0, 0);
  if (fields.mapRepeat) texture.repeat.fromArray(fields.mapRepeat);
  if (fields.mapOffset) texture.offset.fromArray(fields.mapOffset);
  if (fields.mapRotation !== undefined) texture.rotation = MathUtils.degToRad(fields.mapRotation);
  texture.needsUpdate = true;
  return texture;
}

/**
 * The material a part shows: its own class, or a physical one while it lets light through.
 * @param current - The object's current material for the part.
 * @param entry - The part's own state.
 * @param physical - Whether the part needs the physical class.
 * @returns A material reset to the part's own values, `current` itself when its class fits.
 */
function resetMaterial(current: Material, entry: LookPartEntry, physical: boolean): Material {
  const original = entry.original;
  const fromStandard = physical && original.type !== 'MeshPhysicalMaterial';
  const Target = fromStandard ? MeshPhysicalMaterial : (original.constructor as new () => Material);
  const material = current.constructor === Target ? current : new Target();
  if (fromStandard) {
    MeshStandardMaterial.prototype.copy.call(material as MeshStandardMaterial, original as MeshStandardMaterial);
    // MeshStandardMaterial.copy leaves only STANDARD; the physical program needs both.
    (material as MeshPhysicalMaterial).defines = { STANDARD: '', PHYSICAL: '' };
    (material as MeshPhysicalMaterial).transmission = 0;
  } else material.copy(original);
  return material;
}

/**
 * Write a look onto one object's own materials (inner#1693 design 5.2): each material is reset to its part's own state,
 * then the stored fields apply; a user picture shows only when `picture` returns it, otherwise the own picture and tiling.
 * @param root - The object's instance root, whose materials are its own.
 * @param table - The model's part table.
 * @param look - The object's stored look.
 * @param options - The theme colour and the usable pictures.
 * @returns Whether any material's shader program inputs changed (class, picture presence, transmission past 0).
 */
export function applyLook(root: Object3D, table: LookPartTable, look: SceneLook, options: ApplyLookOptions): { programChanged: boolean } {
  let programChanged = false;
  eachMaterial(root, (current, replace) => {
    const part = current.userData.lookPart as string | undefined;
    const entry = part === undefined ? undefined : table.get(part);
    if (!part || !entry) return;
    const fields: SceneLookPart = look[part] ?? {};
    const lit = !entry.unlit && !entry.line;
    const physical = lit && ((fields.transmission ?? 0) > 0 || entry.materialType === 'MeshPhysicalMaterial');
    const before = { type: current.constructor, map: Boolean((current as Lit).map), transmission: ((current as Lit).transmission ?? 0) > 0 };
    for (const texture of clones.get(current) ?? []) texture.dispose();
    clones.delete(current);
    const material = resetMaterial(current, entry, physical) as Lit;
    const made: Texture[] = [];

    let showingUser = false;
    if (!entry.line && 'map' in material) {
      const userPicture = fields.map && fields.map !== 'none' ? options.picture(fields.map) : null;
      if (fields.map === 'none') material.map = null;
      else if (userPicture) {
        material.map = tiled(userPicture, fields);
        made.push(material.map);
        showingUser = true;
      } else if (!fields.map && material.map
        && (fields.mapRepeat !== undefined || fields.mapOffset !== undefined || fields.mapRotation !== undefined)) {
        material.map = tiled(material.map, fields);
        made.push(material.map);
      }
    }
    if (material.color) {
      const own = entry.builtin ? options.themeColor : entry.color;
      if (fields.color !== undefined) material.color.set(fields.color);
      else material.color.set(showingUser ? WHITE : own);
    }
    if (lit) {
      if (fields.roughness !== undefined) material.roughness = fields.roughness;
      if (fields.metalness !== undefined) material.metalness = fields.metalness;
      if (fields.emissive !== undefined) material.emissive.set(fields.emissive);
      if (fields.emissiveIntensity !== undefined) material.emissiveIntensity = fields.emissiveIntensity;
      if (physical) material.transmission = fields.transmission ?? entry.transmission;
    }
    if (fields.opacity !== undefined) {
      material.opacity = fields.opacity;
      if (fields.opacity < 1) {
        material.transparent = true;
        material.depthWrite = false;
      }
    }
    material.needsUpdate = true;
    if (made.length > 0) clones.set(material, made);
    if (material !== current) {
      replace(material);
      current.dispose();
    }
    const after = { type: material.constructor, map: Boolean(material.map), transmission: (material.transmission ?? 0) > 0 };
    if (before.type !== after.type || before.map !== after.map || before.transmission !== after.transmission) programChanged = true;
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
