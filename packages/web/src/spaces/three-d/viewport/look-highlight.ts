// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  InstancedMesh, Mesh, MeshBasicMaterial, SkinnedMesh, type ColorRepresentation, type Intersection, type Material, type Object3D,
} from 'three';

/** A shown part highlight. */
export interface PartHighlight {
  overlays: Mesh[];
  remove: () => void;
}

/**
 * The material slots of a mesh.
 * @param mesh - The mesh.
 * @returns Its materials as a list.
 */
function slots(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

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
 * Cover every mesh of one part with a tinted overlay child (inner#1693 design 5.5). Overlays are not picked, cast or
 * receive no shadow, are marked `lookHighlight` so outlines, bounds and the minimap skip them, and are never culled, so
 * a pose that moves the mesh moves them too.
 * @param root - The object's instance root.
 * @param part - The highlighted part.
 * @param color - The tint.
 * @returns The overlays and their removal.
 */
export function addPartHighlight(root: Object3D, part: string, color?: ColorRepresentation): PartHighlight {
  const tint = new MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  if (color !== undefined) tint.color.set(color);
  const hidden = new MeshBasicMaterial({ visible: false });
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh && !mesh.userData.lookHighlight && slots(mesh).some((material) => material.userData.lookPart === part)) meshes.push(mesh);
  });
  const overlays = meshes.map((mesh) => {
    const material = Array.isArray(mesh.material)
      ? mesh.material.map((slot) => (slot.userData.lookPart === part ? tint : hidden))
      : tint;
    const overlay = overlayOf(mesh, material);
    overlay.userData.lookHighlight = true;
    overlay.castShadow = false;
    overlay.receiveShadow = false;
    overlay.frustumCulled = false;
    overlay.raycast = (): void => {};
    mesh.add(overlay);
    return overlay;
  });
  return {
    overlays,
    remove: (): void => {
      overlays.forEach((overlay) => overlay.removeFromParent());
      tint.dispose();
      hidden.dispose();
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
