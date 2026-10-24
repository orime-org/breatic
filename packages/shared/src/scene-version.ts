// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from "yjs";

/** The scene document format understood by this build. */
export const SCENE_FORMAT_VERSION = 1;

/**
 * Initialize a new 3D Space document without replacing existing scene data.
 *
 * Empty root maps are declared locally: Yjs encodes their entries, not an
 * empty root declaration. Readers bind the same named maps after decoding.
 * Existing content is retained, including data with missing version metadata.
 * This initializer is not an upgrader.
 * @param doc - The Space's scene document.
 * @throws {Error} When a named root already has an incompatible shared type.
 */
export function initializeSceneDocument(doc: Y.Doc): void {
  const scene = doc.getMap<unknown>("scene");
  const objects = doc.getMap<unknown>("objects");
  if (scene.size > 0 || objects.size > 0) return;
  doc.transact(() => {
    scene.set("formatVersion", SCENE_FORMAT_VERSION);
  });
}
