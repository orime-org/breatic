// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from "yjs";

/** The scene document format understood by this build. */
export const SCENE_FORMAT_VERSION = 1;

/**
 * Bind a scene root and validate its map-only content structure.
 * @param doc - The Space's scene document.
 * @param name - Root defined by the scene format.
 * @returns The validated root map.
 * @throws {Error} When the root has an incompatible type or sequence content.
 */
export function getSceneRootMap(doc: Y.Doc, name: "scene" | "objects"): Y.Map<unknown> {
  const root = doc.getMap<unknown>(name);
  // Decoded roots acquire their constructor on getMap; sequence content survives that binding.
  if (root._start !== null) throw new Error(`Scene root ${name} contains sequence content`);
  return root;
}

/**
 * Initialize version metadata on an empty 3D Space document.
 *
 * Empty root maps are declared locally: Yjs encodes their entries, not an
 * empty root declaration. Readers bind the same named maps after decoding.
 * Existing entries and version metadata remain intact.
 * @param doc - The Space's scene document.
 * @throws {Error} When a named root contains incompatible shared content.
 */
export function initializeSceneDocument(doc: Y.Doc): void {
  const scene = getSceneRootMap(doc, "scene");
  const objects = getSceneRootMap(doc, "objects");
  if (scene.size > 0 || objects.size > 0) return;
  doc.transact(() => {
    scene.set("formatVersion", SCENE_FORMAT_VERSION);
  });
}
