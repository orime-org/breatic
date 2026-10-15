// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup's export (inner#1303 §6.2): the picture with every object drawn
 * on it, at the picture's own resolution. The objects go through the same
 * conversion the node's canvas draws with, so the two match. Fabric loads on
 * first use.
 */

import { pngOf, prepareCropSource, type CropSource } from '@web/spaces/canvas/focus/crop-export';
import { intrinsicSize } from '@web/spaces/canvas/focus/crop-source';
import type { MarkObject } from '@web/stores/mark-draft';

/**
 * Export the source with the markup's objects on it as a PNG at its own resolution.
 * @param source - The picture.
 * @param objects - The objects copied out at the press.
 * @returns The PNG.
 * @throws {Error} When the source fails to load CORS-clean, or the canvas cannot export.
 */
export async function exportMarkBlob(source: CropSource, objects: readonly MarkObject[]): Promise<Blob> {
  const [el, { StaticCanvas }, { markBackground, toFabric }] = await Promise.all([
    prepareCropSource(source),
    import('fabric'),
    import('@web/spaces/canvas/mini-tool/mark-fabric'),
  ]);
  const size = intrinsicSize(el);
  const scene = new StaticCanvas(undefined, { ...size, enableRetinaScaling: false, renderOnAddRemove: false });
  try {
    scene.backgroundImage = markBackground(el);
    for (const object of objects) scene.add(toFabric(object, size));
    scene.renderAll();
    return await pngOf(scene.getElement());
  } finally {
    void scene.dispose();
  }
}
