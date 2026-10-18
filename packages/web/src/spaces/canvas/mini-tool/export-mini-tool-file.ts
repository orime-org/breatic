// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { parseAdjustValue } from '@breatic/shared';
import {
  UPRIGHT,
  gridShapeOf,
  outputTemplateOf,
  pickedCellsOf,
  type MiniToolSnapshot,
  type MiniToolSpec,
} from '@breatic/shared/mini-tools';

import {
  exportCropBlob,
  exportOrientedBlob,
  type CropSource,
  type Orientation,
} from '@web/spaces/canvas/focus/crop-export';
import { exportAdjustedBlob } from '@web/spaces/canvas/mini-tool/adjust-export';
import { exportGridTiles } from '@web/spaces/canvas/mini-tool/grid-export';
import { exportMarkBlob } from '@web/spaces/canvas/mini-tool/mark-export';
import type { CropRect } from '@web/spaces/canvas/mini-tool/mini-tool-view';
import type { ExportedFile, MiniToolCapture } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';

/**
 * Make a browser tool's file from the snapshot taken at the press
 * (inner#888 §7.5): the crop, the turned picture, the adjusted or marked-up
 * picture or the grid's picked tiles, as PNGs at the source's own resolution.
 * @param spec - The browser tool.
 * @param snapshot - The draft as it stood at the press.
 * @param capture - What the reader made on the node, copied out at the press.
 * @returns The files to upload, one per result, named after the tool's output.
 * @throws {Error} When the tool is not one this end draws, or the export fails.
 */
export async function exportMiniToolFile(
  spec: MiniToolSpec,
  snapshot: MiniToolSnapshot,
  capture?: MiniToolCapture,
): Promise<ExportedFile[]> {
  const source: CropSource = { url: snapshot.source.url, timeSeconds: null };
  const shape = gridShapeOf(spec, snapshot.params);
  if (shape !== null) {
    const tiles = await exportGridTiles(source, shape.rows, shape.cols, pickedCellsOf(spec, snapshot.params) ?? []);
    const prefix = outputTemplateOf(spec).namePrefix;
    return tiles.map((tile) => ({ file: new File([tile.blob], `${prefix}.png`, { type: 'image/png' }) }));
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
  } else if (spec.id === 'image.mark' && capture?.kind === 'mark') {
    blob = await exportMarkBlob(source, capture.objects);
  } else if (spec.id === 'image.rotate') {
    blob = await exportOrientedBlob(source, (snapshot.params.orient as Orientation | undefined) ?? UPRIGHT);
  } else {
    throw new Error(`no browser export for ${spec.id}`);
  }
  const prefix = outputTemplateOf(spec).namePrefix;
  return [{ file: new File([blob], `${prefix}.png`, { type: 'image/png' }) }];
}
