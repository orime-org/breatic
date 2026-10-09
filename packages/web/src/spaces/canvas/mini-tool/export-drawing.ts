// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The images a mask or sketch tool's run is sent (inner#1302 §6.4), made in
 * the browser from the source and the drawing. The raster half is covered by
 * the real-browser smoke; jsdom has no image decode or canvas raster.
 */

import { intrinsicSize } from '@web/spaces/canvas/focus/crop-source';
import { pngOf, prepareCropSource } from '@web/spaces/canvas/focus/crop-export';
import { inkShows, isInk, paintDrawing, type DrawingKind } from '@web/spaces/canvas/mini-tool/paint-drawing';
import type { DrawOp } from '@web/stores/drawing-draft';

/** The drawing leaves nothing on the picture: no white in a mask, no ink on a sketch. */
export class DrawingEmptyError extends Error {
  /** Name the error. */
  constructor() {
    super('the drawing leaves nothing on the picture');
    this.name = 'DrawingEmptyError';
  }
}

/** What a drawing tool's run is sent: the picture, and for a mask the mask beside it. */
export interface DrawingExport {
  image: Blob;
  mask?: Blob;
}

/**
 * A canvas the given size, with its 2D context.
 * @param size - The size.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @returns The canvas and context.
 * @throws {Error} When the browser gives no 2D context.
 */
function blankCanvas(size: { width: number; height: number }): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d context unavailable');
  return { canvas, ctx };
}

/**
 * Export what a mask or sketch tool sends, at the source's own pixels as the
 * browser decodes it (turned upright by its EXIF orientation). A mask is the
 * upright source and a black image of the same size, white where painted; a
 * sketch is the upright source with the drawing painted over it.
 * @param url - The source image.
 * @param kind - Mask or sketch.
 * @param ops - The visible ops.
 * @returns The images to upload.
 * @throws {DrawingEmptyError} When the drawing leaves nothing.
 * @throws {Error} When the source fails to load CORS-clean, or a canvas cannot export.
 */
export async function exportDrawing(url: string, kind: DrawingKind, ops: readonly DrawOp[]): Promise<DrawingExport> {
  const el = await prepareCropSource({ url, timeSeconds: null });
  const size = intrinsicSize(el);
  const layer = blankCanvas(size);
  paintDrawing(layer.ctx, ops, size, kind, '#fff'); // design-value: allow — mask white, image content
  const pixels = layer.ctx.getImageData(0, 0, size.width, size.height);
  if (!inkShows(pixels.data)) throw new DrawingEmptyError();
  // Temporary: the stored asset keeps its EXIF orientation and the models
  // read raw pixels, so a mask tool sends this upright re-encode in its place,
  // one more upload per run. Drop it for the stored source once uploads are
  // turned upright on ingest (inner#1367).
  const source = blankCanvas(size);
  source.ctx.drawImage(el, 0, 0);
  if (kind === 'sketch') {
    source.ctx.drawImage(layer.canvas, 0, 0);
    return { image: await pngOf(source.canvas) };
  }
  // White painted over black reads as its alpha; ink is white, the rest black.
  for (let i = 0; i < pixels.data.length; i += 4) {
    const value = isInk(pixels.data[i + 3] ?? 0) ? 255 : 0;
    pixels.data[i] = value;
    pixels.data[i + 1] = value;
    pixels.data[i + 2] = value;
    pixels.data[i + 3] = 255;
  }
  layer.ctx.putImageData(pixels, 0, 0);
  return { image: await pngOf(source.canvas), mask: await pngOf(layer.canvas) };
}
