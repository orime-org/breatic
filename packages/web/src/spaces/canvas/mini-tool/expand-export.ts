// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The expand tool's two images (inner#1303 §6.3): the source padded onto the
 * frame's canvas, the new area transparent, and a mask of the same size,
 * white where the canvas is new and black over the source. The layout is
 * pure; the raster half is checked in the browser.
 */

import { pngOf, prepareCropSource } from '@web/spaces/canvas/focus/crop-export';
import type { ExpandFrame, PixelSize } from '@web/spaces/canvas/mini-tool/expand-frame';
import type { ExpandExport } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';

/** The padded canvas's size and where the source's top left sits on it, in source pixels. */
export interface ExpandLayout {
  width: number;
  height: number;
  sourceX: number;
  sourceY: number;
}

/**
 * Lay the source on the frame's canvas in whole pixels, never cutting into it.
 * @param frame - The frame, as shares of the source.
 * @param source - The source's pixels.
 * @returns The canvas size and the source's offset on it.
 */
export function expandLayout(frame: ExpandFrame, source: PixelSize): ExpandLayout {
  const sourceX = Math.round(-frame.x * source.width);
  const sourceY = Math.round(-frame.y * source.height);
  return {
    width: Math.max(sourceX + source.width, Math.round(frame.width * source.width)),
    height: Math.max(sourceY + source.height, Math.round(frame.height * source.height)),
    sourceX,
    sourceY,
  };
}

/**
 * Make the padded picture and its mask.
 * @param url - The source's address.
 * @param frame - The frame at the press.
 * @param source - The source's pixels the frame was measured against.
 * @returns Both PNGs.
 * @throws {Error} When the source fails to load CORS-clean, or a canvas cannot export.
 */
export async function exportExpand(url: string, frame: ExpandFrame, source: PixelSize): Promise<ExpandExport> {
  const el = await prepareCropSource({ url, timeSeconds: null });
  const layout = expandLayout(frame, source);
  /**
   * A blank canvas the padded size.
   * @returns The canvas and its context.
   */
  const canvas = (): { el: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
    const made = document.createElement('canvas');
    made.width = layout.width;
    made.height = layout.height;
    const ctx = made.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    return { el: made, ctx };
  };
  const image = canvas();
  image.ctx.drawImage(el, layout.sourceX, layout.sourceY, source.width, source.height);
  const mask = canvas();
  mask.ctx.fillStyle = '#fff'; // design-value: allow — mask white, image content
  mask.ctx.fillRect(0, 0, layout.width, layout.height);
  mask.ctx.fillStyle = '#000'; // design-value: allow — mask black, image content
  mask.ctx.fillRect(layout.sourceX, layout.sourceY, source.width, source.height);
  const [imageBlob, maskBlob] = await Promise.all([pngOf(image.el), pngOf(mask.el)]);
  return { image: imageBlob, mask: maskBlob };
}
