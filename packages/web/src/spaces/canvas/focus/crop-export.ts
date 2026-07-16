// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Browser-side crop export for the focus tool (#1782) — loads the source
 * image CORS-clean and draws the natural-pixel crop to an offscreen
 * canvas. Pure browser API; covered by the real-browser smoke (jsdom has
 * no image decode / canvas raster).
 */

import type { CropRect } from '@web/spaces/canvas/focus/crop-math';

/**
 * Export a crop of the source image as a PNG blob at natural resolution.
 *
 * The image is re-requested with `crossOrigin='anonymous'` plus a
 * cache-busting query param: the node's own `<img>` loaded WITHOUT
 * crossOrigin, and serving that cached no-cors response to a CORS request
 * is the classic canvas-taint trap — the extra param guarantees a fresh
 * CORS-mode fetch (the 2026-07-16 probe verified the bucket serves ACAO).
 * PNG keeps the export lossless and alpha-safe regardless of the source
 * format.
 * @param sourceUrl - The source image URL (public asset).
 * @param crop - The crop rect in natural (source-resolution) pixels.
 * @returns The cropped PNG blob.
 * @throws {Error} When the image fails to load CORS-clean or the canvas
 *   cannot export (tainted / zero-sized crop).
 */
export async function exportCropBlob(
  sourceUrl: string,
  crop: CropRect,
): Promise<Blob> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = `${sourceUrl}${sourceUrl.includes('?') ? '&' : '?'}focus-crop=1`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('canvas export produced no blob');
  return blob;
}
