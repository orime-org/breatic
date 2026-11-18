// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  InstancedMesh, LineBasicMaterial, Mesh, MeshBasicMaterial, Points, PointsMaterial, SkinnedMesh, type BufferGeometry, type ColorRepresentation,
  type Intersection, type Line, type Material, type Object3D,
} from 'three';

/** A drawn object a part can be on: a triangle mesh, a line or points. */
type Drawable = Mesh | Line | Points;

/** A shown part highlight. */
export interface PartHighlight {
  overlays: Drawable[];
  remove: () => void;
}

/**
 * The material slots of a drawn object.
 * @param drawable - The object.
 * @returns Its materials as a list.
 */
function slots(drawable: Drawable): Material[] {
  return Array.isArray(drawable.material) ? drawable.material : [drawable.material];
}

/** The highlight's opacity over the part. */
const TINT_OPACITY = 0.35;

/**
 * An overlay drawing the same geometry as a mesh: a skinned mesh shares its skeleton and bind matrix, an instanced mesh
 * its instance matrices, every mesh its morph influences.
 * @param mesh - The mesh to cover.
 * @param material - The overlay material, per slot when the mesh has several.
 * @returns The overlay, not yet attached.
 */
function overlayOf(mesh: Mesh, material: Material | Material[]): Mesh {
  let overlay: Mesh;
  if ((mesh as SkinnedMesh).isSkinnedMesh) {
    const skinned = mesh as SkinnedMesh;
    const copy = new SkinnedMesh(mesh.geometry, material);
    copy.bindMode = skinned.bindMode;
    copy.bind(skinned.skeleton, skinned.bindMatrix);
    // The same box and sphere objects: a pose recomputes the source's in place, and the overlay follows.
    if (!skinned.boundingBox) skinned.computeBoundingBox();
    if (!skinned.boundingSphere) skinned.computeBoundingSphere();
    copy.boundingBox = skinned.boundingBox;
    copy.boundingSphere = skinned.boundingSphere;
    overlay = copy;
  } else if ((mesh as InstancedMesh).isInstancedMesh) {
    const instanced = mesh as InstancedMesh;
    const copy = new InstancedMesh(mesh.geometry, material, instanced.count);
    copy.instanceMatrix = instanced.instanceMatrix;
    overlay = copy;
  } else overlay = new Mesh(mesh.geometry, material);
  overlay.morphTargetInfluences = mesh.morphTargetInfluences;
  return overlay;
}

/**
 * Cover every mesh, line and points object of one part with a tinted overlay child of the same kind (inner#1693 design 5.5). Overlays are not picked, cast or
 * receive no shadow, are marked `lookHighlight` so outlines, bounds and the minimap skip them, and are never culled, so
 * a pose that moves the mesh moves them too.
 * @param root - The object's instance root.
 * @param part - The highlighted part.
 * @param color - The tint.
 * @returns The overlays and their removal.
 */
export function addPartHighlight(root: Object3D, part: string, color?: ColorRepresentation): PartHighlight {
  const tint = new MeshBasicMaterial({ transparent: true, opacity: TINT_OPACITY, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const lineTint = new LineBasicMaterial({ transparent: true, opacity: TINT_OPACITY, depthWrite: false });
  const hidden = new MeshBasicMaterial({ visible: false });
  const made: Material[] = [tint, lineTint, hidden];
  /**
   * A tint for points as large as the part's own.
   * @param source - The part's points material.
   * @returns The tint.
   */
  const pointsTint = (source: Material): PointsMaterial => {
    const own = source as PointsMaterial;
    const material = new PointsMaterial({ transparent: true, opacity: TINT_OPACITY, depthWrite: false, size: own.size, sizeAttenuation: own.sizeAttenuation });
    made.push(material);
    return material;
  };
  const drawables: Drawable[] = [];
  root.traverse((object) => {
    const drawable = object as Drawable;
    const drawn = (drawable as Mesh).isMesh || (drawable as Line).isLine || (drawable as Points).isPoints;
    if (drawn && !drawable.userData.lookHighlight && slots(drawable).some((material) => material.userData.lookPart === part)) drawables.push(drawable);
  });
  const overlays = drawables.map((drawable) => {
    const overlay = (drawable as Mesh).isMesh ? overlayOf(drawable as Mesh, Array.isArray(drawable.material)
      ? drawable.material.map((slot) => (slot.userData.lookPart === part ? tint : hidden))
      : tint)
      : (drawable as Points).isPoints ? new Points(drawable.geometry, pointsTint(slots(drawable)[0]!))
        : new (drawable.constructor as new (geometry: BufferGeometry, material: Material) => Line)(drawable.geometry, lineTint);
    if (!(drawable as Mesh).isMesh) overlay.morphTargetInfluences = drawable.morphTargetInfluences;
    overlay.userData.lookHighlight = true;
    overlay.castShadow = false;
    overlay.receiveShadow = false;
    overlay.frustumCulled = false;
    overlay.raycast = (): void => {};
    drawable.add(overlay);
    return overlay;
  });
  if (color !== undefined) for (const material of made) (material as MeshBasicMaterial).color.set(color);
  return {
    overlays,
    remove: (): void => {
      overlays.forEach((overlay) => overlay.removeFromParent());
      made.forEach((material) => material.dispose());
    },
  };
}

/**
 * The part a hit landed on: the hit mesh's material, by face group on a multi-material mesh.
 * @param hit - A raycast hit.
 * @returns The part key, or null when the material carries none.
 */
export function partAtHit(hit: Intersection): string | null {
  const material = (hit.object as Mesh).material as Material | Material[] | undefined;
  const slot = Array.isArray(material) ? material[hit.face?.materialIndex ?? 0] : material;
  const part: unknown = slot?.userData.lookPart;
  return typeof part === 'string' ? part : null;
}

/** What a click on the scene does. */
export type ScenePick = { kind: 'select'; id: string | null; additive: boolean } | { kind: 'part'; part: string };

/**
 * Decide a click past the joint dots and the pose target, which the viewport handles first (inner#1693 design 5.6):
 * Shift adds or removes, a plain click on the only selected object picks the part under the pointer, anything else
 * selects what was hit.
 * @param input - The click's facts.
 * @param input.shift - Whether Shift was held.
 * @param input.hitId - The hit object, or null.
 * @param input.onlySelected - The object when exactly one is selected, or null.
 * @param input.part - The part under the pointer, or null.
 * @returns The action.
 */
export function decideScenePick(input: { shift: boolean; hitId: string | null; onlySelected: string | null; part: string | null }): ScenePick {
  if (input.shift) return { kind: 'select', id: input.hitId, additive: true };
  if (input.hitId !== null && input.hitId === input.onlySelected && input.part !== null) return { kind: 'part', part: input.part };
  return { kind: 'select', id: input.hitId, additive: false };
}
