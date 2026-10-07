// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolSnapshot, MiniToolSpec } from '@breatic/shared/mini-tools';

import {
  exportCropBlob,
  exportOrientedBlob,
  type CropSource,
  type Orientation,
} from '@web/spaces/canvas/focus/crop-export';
import type { CropRect } from '@web/spaces/canvas/mini-tool/mini-tool-view';

/** No turn and no flip: the picture as it is. */
const UPRIGHT: Orientation = { turns: 0, flipX: false, flipY: false };

/**
 * Make a browser tool's file from the snapshot taken at the press
 * (inner#888 §7.5): the crop or the turned picture, as a PNG at the source's
 * own resolution.
 * @param spec - The browser tool.
 * @param snapshot - The draft as it stood at the press.
 * @returns The file to upload, named after the tool's output.
 * @throws {Error} When the tool is not one this end draws, or the export fails.
 */
export async function exportMiniToolFile(spec: MiniToolSpec, snapshot: MiniToolSnapshot): Promise<File> {
  const source: CropSource = { url: snapshot.source.url, timeSeconds: null };
  let blob: Blob;
  if (spec.id === 'image.crop') {
    const rect = snapshot.params.rect as CropRect | null | undefined;
    blob =
      rect === null || rect === undefined
        ? await exportOrientedBlob(source, UPRIGHT)
        : await exportCropBlob(source, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  } else if (spec.id === 'image.rotate') {
    blob = await exportOrientedBlob(source, (snapshot.params.orient as Orientation | undefined) ?? UPRIGHT);
  } else {
    throw new Error(`no browser export for ${spec.id}`);
  }
  const prefix = spec.outputs[0]?.namePrefix ?? 'IMAGE';
  return new File([blob], `${prefix}.png`, { type: 'image/png' });
}
