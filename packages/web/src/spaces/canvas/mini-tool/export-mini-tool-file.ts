// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { parseAdjustValue } from '@breatic/shared';
import { UPRIGHT, defaultParamsOf, outputTemplateOf, type MiniToolSnapshot, type MiniToolSpec } from '@breatic/shared/mini-tools';

import {
  exportCropBlob,
  exportOrientedBlob,
  type CropSource,
  type Orientation,
} from '@web/spaces/canvas/focus/crop-export';
import { exportAdjustedBlob } from '@web/spaces/canvas/mini-tool/adjust-export';
import { exportGridTiles } from '@web/spaces/canvas/mini-tool/grid-export';
import type { CropRect } from '@web/spaces/canvas/mini-tool/mini-tool-view';
import type { ExportedFile } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';

/**
 * Make a browser tool's file from the snapshot taken at the press
 * (inner#888 §7.5): the crop, the turned picture or the grid's tiles, as PNGs
 * at the source's own resolution.
 * @param spec - The browser tool.
 * @param snapshot - The draft as it stood at the press.
 * @returns The files to upload, one per result, named after the tool's output.
 * @throws {Error} When the tool is not one this end draws, or the export fails.
 */
export async function exportMiniToolFile(spec: MiniToolSpec, snapshot: MiniToolSnapshot): Promise<ExportedFile[]> {
  const source: CropSource = { url: snapshot.source.url, timeSeconds: null };
  if (spec.id === 'image.grid') {
    const params = { ...defaultParamsOf(spec), ...snapshot.params };
    const tiles = await exportGridTiles(source, params.rows as number, params.cols as number);
    const prefix = outputTemplateOf(spec).namePrefix;
    return tiles.map((tile) => ({
      file: new File([tile.blob], `${prefix}.png`, { type: 'image/png' }),
      size: { width: tile.width, height: tile.height },
    }));
  }
  let blob: Blob;
  if (spec.id === 'image.crop') {
    const rect = snapshot.params.rect as CropRect | null | undefined;
    blob =
      rect === null || rect === undefined
        ? await exportOrientedBlob(source, UPRIGHT)
        : await exportCropBlob(source, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  } else if (spec.id === 'image.adjust') {
    blob = await exportAdjustedBlob(source, parseAdjustValue(snapshot.params.value));
  } else if (spec.id === 'image.rotate') {
    blob = await exportOrientedBlob(source, (snapshot.params.orient as Orientation | undefined) ?? UPRIGHT);
  } else {
    throw new Error(`no browser export for ${spec.id}`);
  }
  const prefix = outputTemplateOf(spec).namePrefix;
  return [{ file: new File([blob], `${prefix}.png`, { type: 'image/png' }) }];
}
